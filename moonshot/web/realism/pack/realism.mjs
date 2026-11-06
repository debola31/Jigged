// The realism pipeline's gltf-transform steps (moonshot/web/realism/pipeline.py writes each job file):
//
//   node realism.mjs simplify <job.json>   source GLBs simplified to the asset's triangle cap (meshoptimizer)
//   node realism.mjs pack <job.json>       Blender's raw export -> the page's GLB: materials from the library, the
//                                          shared tiles referenced (not embedded), AO embedded as KTX2, one draw per
//                                          material, meshopt-compressed and quantised; writes a report
//   node realism.mjs validate <job.json>   the Khronos glTF validator, external tiles resolved from disk
//
// Run from <data>/realism/node, where pipeline.py installs package.json; never from the checkout.
import fs from 'node:fs';
import path from 'node:path';
import { NodeIO, PropertyType } from '@gltf-transform/core';
import {
	ALL_EXTENSIONS, KHRTextureTransform, KHRTextureBasisu, KHRMaterialsClearcoat, KHRMaterialsEmissiveStrength,
} from '@gltf-transform/extensions';
import { dedup, prune, join, flatten, weld, simplify, meshopt, getBounds } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder, MeshoptSimplifier } from 'meshoptimizer';
import validator from 'gltf-validator';

const [cmd, jobPath] = process.argv.slice(2);
const job = JSON.parse(fs.readFileSync(jobPath, 'utf8'));
await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
	.registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });

const triangles = (doc) => doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives())
	.reduce((n, p) => n + (p.getIndices() ? p.getIndices().getCount() : p.getAttribute('POSITION').getCount()) / 3, 0);

// The sources together to the cap, each by the same ratio; under the cap they are copied as they are. The error
// bound stops the simplifier before it spoils a silhouette, so on dense CAD it can stall above the cap: then the
// bound is doubled and the sources simplified again, up to MAX_ERROR (1.6% of the radius), and the report says so.
const MAX_ERROR = 0.016;

// A source as the asset uses it: without the links its mapping drops (hidden springs, thread detail), by node name.
async function readSource(src) {
	const doc = await io.read(src);
	const drop = new Set(job.drop_links ?? []);
	if (drop.size) {
		for (const node of doc.getRoot().listNodes()) {
			if (drop.has(node.getName().replace(/\.\d+$/, ''))) node.dispose();
		}
		await doc.transform(prune());
	}
	return doc;
}

// Positions only, welded (a mapping's opt-in): the simplifier won't collapse across a normal or UV seam, and some
// vendor meshes (pre-decimated with split normals, the V-block's) are all seams, so it stalled far above the cap.
// prepare.py recomputes normals for every simplified source anyway, and Blender lays out both UV sets. But a thin
// sheet then collapses through its thickness (the wire EDM's panels vanished): solid parts only, small error bounds.
function positionsOnly(doc) {
	for (const prim of doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives())) {
		for (const semantic of prim.listSemantics()) {
			if (semantic !== 'POSITION') prim.setAttribute(semantic, null);
		}
	}
}

// The ratio applies to every primitive alike, and the small ones (bolts, a CAD material's few faces) can't come
// down: so the total lands above the cap, by more the higher the ratio. Each pass that misses the cap scales the
// ratio by cap / result for the next (not below 0.6 of the first) and doubles the error bound, up to the largest
// allowed; it stops once a pass gains under 3%.
const PASSES = 8;

async function simplifyAll() {
	const total = (await Promise.all(job.inputs.map((s) => readSource(s.src)))).reduce((n, d) => n + triangles(d), 0);
	let ratio = Math.min(1, job.cap / total);
	let error = job.error;
	const maxError = (job.max_error ?? MAX_ERROR) + 1e-12;
	// below this the ratio only crushes the parts that can still come down (the laser lost 4% of its area at 0.03)
	const ratioFloor = 0.6 * ratio;
	let out, last;
	for (let pass = 0; pass < PASSES; pass++) {
		out = { cap: job.cap, before: total, ratio, error, passes: pass + 1, dropped: job.drop_links ?? [], files: [] };
		for (const s of job.inputs) {
			const doc = await readSource(s.src);
			const before = triangles(doc);
			if (ratio < 1 && before > 500) {
				if (job.positions_only) positionsOnly(doc);
				await doc.transform(weld(), prune(), simplify({ simplifier: MeshoptSimplifier, ratio, error }));
				await io.write(s.dst, doc);
			} else if (job.drop_links?.length) {
				await io.write(s.dst, doc);
			} else {
				fs.copyFileSync(s.src, s.dst);
			}
			out.files.push({ src: s.src, before, after: triangles(doc) });
		}
		out.after = out.files.reduce((n, f) => n + f.after, 0);
		console.log(`[simplify] ratio ${ratio.toFixed(3)}, error ${error}: ${total} -> ${out.after} triangles (cap ${job.cap})`);
		if (out.after <= job.cap * 1.05 || out.after > 0.97 * (last ?? Infinity)) break;   // there, or stuck
		last = out.after;
		ratio = Math.max(ratio * job.cap / out.after, ratioFloor);
		if (error * 2 <= maxError) error *= 2;
	}
	fs.writeFileSync(job.report, JSON.stringify(out, null, 1));
}

// A shared tile is a texture whose image is a file in <web>/tiles/, referenced by URI. gltf-transform always embeds
// images in a GLB, so the texture is written with a placeholder (its URI's bytes) and externalize() swaps the
// placeholder for the URI afterwards.
const TILE = 'tile:';

async function pack() {
	const doc = await io.read(job.raw);
	const root = doc.getRoot();
	const tt = doc.createExtension(KHRTextureTransform);
	doc.createExtension(KHRTextureBasisu).setRequired(true);
	const cc = doc.createExtension(KHRMaterialsClearcoat);
	const es = doc.createExtension(KHRMaterialsEmissiveStrength);
	const textures = new Map();
	const tile = (file) => {
		if (!textures.has(file)) {
			const uri = job.tiles_uri + file;
			textures.set(file, doc.createTexture(TILE + file).setImage(new TextEncoder().encode(uri))
				.setMimeType('image/ktx2').setURI(uri));
		}
		return textures.get(file);
	};
	const ao = job.ao_ktx2 ? doc.createTexture('ao').setImage(fs.readFileSync(job.ao_ktx2)).setMimeType('image/ktx2')
		: null;
	const missing = [];
	for (const mat of root.listMaterials()) {
		const name = mat.getName().split('.')[0];
		const r = job.materials[name];
		if (!r) { missing.push(name); continue; }
		const fam = job.families[r.family]?.files ?? {};
		const s = 1 / r.tile_m;
		const place = (info) => info.setTexCoord(0).setExtension('KHR_texture_transform',
			tt.createTransform().setScale([s, s]).setOffset([0, 0]));
		mat.setName(name).setBaseColorFactor(r.baseColorFactor).setRoughnessFactor(r.roughnessFactor)
			.setMetallicFactor(r.metallicFactor).setDoubleSided(r.doubleSided || !!job.double_sided)
			.setAlphaMode(r.baseColorFactor[3] < 1 ? 'BLEND' : 'OPAQUE');
		if (fam.base) place(mat.setBaseColorTexture(tile(fam.base.file)).getBaseColorTextureInfo());
		if (fam.mr) place(mat.setMetallicRoughnessTexture(tile(fam.mr.file)).getMetallicRoughnessTextureInfo());
		if (fam.nrm) place(mat.setNormalTexture(tile(fam.nrm.file)).setNormalScale(r.normalScale).getNormalTextureInfo());
		if (ao) mat.setOcclusionTexture(ao).setOcclusionStrength(1).getOcclusionTextureInfo().setTexCoord(1);
		if (r.clearcoat) mat.setExtension('KHR_materials_clearcoat', cc.createClearcoat()
			.setClearcoatFactor(r.clearcoat[0]).setClearcoatRoughnessFactor(r.clearcoat[1]));
		if (r.emissive) {
			mat.setEmissiveFactor(r.emissive[0]);
			mat.setExtension('KHR_materials_emissive_strength', es.createEmissiveStrength().setEmissiveStrength(r.emissive[1]));
		}
		mat.setExtras({ library: name, family: r.family });
	}
	if (missing.length) throw new Error(`no library material for ${missing.join(', ')}`);
	// Nothing in the shop moves: one node, one mesh, one primitive (one draw) per material.
	// dedup() leaves textures alone: each tile is made once above, and its placeholder isn't an image it can read.
	await doc.transform(flatten(), join(), dedup({ propertyTypes: [PropertyType.ACCESSOR, PropertyType.MESH,
		PropertyType.MATERIAL] }), prune({ keepAttributes: false }));
	normaliseUv0(doc);
	await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium', quantizePosition: 14,
		quantizeNormal: 10, quantizeTexcoord: 16 }));
	await io.write(job.out, doc);
	externalize(job.out);
	fs.writeFileSync(job.report, JSON.stringify(await describe(job.out), null, 1));
	console.log(`[pack] ${path.basename(job.out)}: ${(fs.statSync(job.out).size / 1e6).toFixed(2)} MB`);
}

// UV0 is a box projection in metres, far outside [0,1], which quantize() leaves as float32 (gltf-transform:
// "UVs outside of [0,1] range are not quantized"). Rescale each primitive's UV0 into [0,1] and fold the scale and
// offset into its material's texture transforms (each material has one primitive after join(); a shared one is
// cloned first), so UV0 quantises to 16 bits like UV1.
function normaliseUv0(doc) {
	const seen = new Set();
	for (const prim of doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives())) {
		const uv = prim.getAttribute('TEXCOORD_0');
		let mat = prim.getMaterial();
		if (!uv || !mat) continue;
		if (seen.has(mat)) prim.setMaterial(mat = mat.clone());
		seen.add(mat);
		const a = uv.getArray();
		let [u0, v0, u1, v1] = [Infinity, Infinity, -Infinity, -Infinity];
		for (let i = 0; i < a.length; i += 2) {
			u0 = Math.min(u0, a[i]); u1 = Math.max(u1, a[i]); v0 = Math.min(v0, a[i + 1]); v1 = Math.max(v1, a[i + 1]);
		}
		const span = Math.max(u1 - u0, v1 - v0, 1e-6);
		const b = new Float32Array(a.length);
		for (let i = 0; i < a.length; i += 2) {
			b[i] = Math.min(1, Math.max(0, (a[i] - u0) / span));
			b[i + 1] = Math.min(1, Math.max(0, (a[i + 1] - v0) / span));
		}
		uv.setArray(b);
		for (const info of [mat.getBaseColorTextureInfo(), mat.getMetallicRoughnessTextureInfo(), mat.getNormalTextureInfo()]) {
			const t = info?.getExtension('KHR_texture_transform');
			if (!t || info.getTexCoord() !== 0) continue;
			const [s] = t.getScale();
			const frac = (x) => x - Math.floor(x);
			t.setScale([s * span, s * span]).setOffset([frac(s * u0), frac(s * v0)]);
		}
	}
}

function readGlb(file) {
	const buf = fs.readFileSync(file);
	const jsonLen = buf.readUInt32LE(12);
	const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf8'));
	const binStart = 20 + jsonLen;
	const bin = binStart < buf.length ? buf.subarray(binStart + 8, binStart + 8 + buf.readUInt32LE(binStart)) : null;
	return { json, bin };
}

function writeGlb(file, json, bin) {
	const pad = (b, fill) => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4, fill)]);
	const j = pad(Buffer.from(JSON.stringify(json), 'utf8'), 0x20);
	const chunks = [Buffer.alloc(8), j];
	chunks[0].writeUInt32LE(j.length, 0);
	chunks[0].writeUInt32LE(0x4e4f534a, 4);
	if (bin) {
		const b = pad(bin, 0);
		const h = Buffer.alloc(8);
		h.writeUInt32LE(b.length, 0);
		h.writeUInt32LE(0x004e4942, 4);
		chunks.push(h, b);
	}
	const body = Buffer.concat(chunks);
	const header = Buffer.alloc(12);
	header.writeUInt32LE(0x46546c67, 0);
	header.writeUInt32LE(2, 4);
	header.writeUInt32LE(12 + body.length, 8);
	fs.writeFileSync(file, Buffer.concat([header, body]));
}

// Each tile image: its placeholder bufferView dropped, its URI set (relative to the GLB), every later bufferView
// renumbered. The placeholder's few bytes stay in the binary chunk, unreferenced.
function externalize(file) {
	const { json, bin } = readGlb(file);
	const drop = new Set();
	for (const img of json.images ?? []) {
		if (!img.name?.startsWith(TILE)) continue;
		drop.add(img.bufferView);
		img.uri = job.tiles_uri + img.name.slice(TILE.length);
		img.name = img.name.slice(TILE.length).replace(/\.ktx2$/, '');
		delete img.bufferView;
	}
	if (!drop.size) return;
	const map = [];
	let k = 0;
	json.bufferViews.forEach((_, i) => { map[i] = drop.has(i) ? -1 : k++; });
	json.bufferViews = json.bufferViews.filter((_, i) => !drop.has(i));
	const remap = (o) => { if (o && o.bufferView !== undefined) o.bufferView = map[o.bufferView]; };
	for (const a of json.accessors ?? []) {
		remap(a);
		if (a.sparse) { remap(a.sparse.indices); remap(a.sparse.values); }
	}
	for (const img of json.images ?? []) remap(img);
	writeGlb(file, json, bin);
}

async function describe(file) {
	const doc = await io.read(file);              // resolves the tiles from disk, as the page will over HTTP
	const prims = doc.getRoot().listMeshes().flatMap((m) => m.listPrimitives());
	const { json } = readGlb(file);
	const accessorBytes = prims.flatMap((p) => [...p.listAttributes(), p.getIndices()].filter(Boolean))
		.reduce((n, a) => n + a.getArray().byteLength, 0);
	const embedded = doc.getRoot().listTextures().filter((t) => !t.getURI()?.includes('tiles/'))
		.map((t) => ({ name: t.getName(), mime: t.getMimeType(), bytes: t.getImage().byteLength, size: t.getSize() }));
	return {
		file: path.basename(file), bytes: fs.statSync(file).size, triangles: triangles(doc), draw_calls: prims.length,
		vertices: prims.reduce((n, p) => n + p.getAttribute('POSITION').getCount(), 0),
		geometry_gpu_bytes: accessorBytes, embedded_textures: embedded,
		tiles: (json.images ?? []).filter((i) => i.uri).map((i) => i.uri),
		materials: doc.getRoot().listMaterials().map((m) => m.getName()),
		extensions_used: json.extensionsUsed, extensions_required: json.extensionsRequired,
		bounds: getBounds(doc.getRoot().listScenes()[0]),
	};
}

async function validate() {
	const dir = path.dirname(job.glb);
	const report = await validator.validateBytes(new Uint8Array(fs.readFileSync(job.glb)), {
		uri: path.basename(job.glb), maxIssues: 200, writeTimestamp: false,
		externalResourceFunction: (uri) => new Promise((resolve, reject) => {
			fs.readFile(path.resolve(dir, decodeURIComponent(uri)), (err, data) => (err ? reject(err) : resolve(new Uint8Array(data))));
		}),
	});
	const out = { errors: report.issues.numErrors, warnings: report.issues.numWarnings, infos: report.issues.numInfos,
		hints: report.issues.numHints, messages: report.issues.messages,
		resources: report.info?.resources?.map((r) => ({ uri: r.uri, image: r.image })), info: report.info };
	fs.writeFileSync(job.report, JSON.stringify(out, null, 1));
	console.log(`[validate] ${path.basename(job.glb)}: ${out.errors} errors, ${out.warnings} warnings, ${out.infos} infos`);
}

// The page-side check: preview/index.html in headless Chromium on the real GPU (ANGLE, D3D11), each shot's
// screenshot and stats, and its GPU frame time (frames forced to finish by a 1-pixel read; rAF is vsync-capped).
async function shots() {
	const { chromium } = await import('playwright-core');
	const browser = await chromium.launch({ headless: true,
		args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'] });
	const out = [];
	for (const s of job.shots) {
		const page = await browser.newPage({ viewport: { width: s.w, height: s.h } });
		const errors = [];
		page.on('pageerror', (e) => errors.push(String(e)));
		page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
		// the page's module script awaits every model before it finishes, which can outlast goto's 30 s for 'load'
		await page.goto(`${job.base}/index.html?${s.query}&w=${s.w}&h=${s.h}&clean=1`,
			{ waitUntil: 'commit', timeout: s.timeout_ms ?? 180000 });
		try {
			await page.waitForFunction(() => window.__ready === true, null, { timeout: s.timeout_ms ?? 180000 });
		} catch (e) {
			out.push({ ...s, errors: [...errors, String(e)] });
			await page.close();
			continue;
		}
		const stats = await page.evaluate(() => window.__stats);
		const frameMs = s.bench ? await page.evaluate((n) => window.__bench(n), s.bench) : null;
		if (s.png) await page.screenshot({ path: s.png });
		out.push({ ...s, stats, frame_ms: frameMs, errors });
		console.log(`[shots] ${s.query}: ${stats.triangles} tris, ${stats.draw_calls} draws, load ${stats.load_ms} ms` +
			(frameMs ? `, ${frameMs} ms/frame` : '') + (errors.length ? `, ${errors.length} errors` : ''));
		await page.close();
	}
	await browser.close();
	fs.writeFileSync(job.report, JSON.stringify(out, null, 1));
}

if (cmd === 'simplify') await simplifyAll();
else if (cmd === 'pack') await pack();
else if (cmd === 'validate') await validate();
else if (cmd === 'shots') await shots();
else throw new Error(`unknown command ${cmd}`);
