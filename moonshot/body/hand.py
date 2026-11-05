"""Ported from trainual's motion/hand_model.py. An anatomical joint layer on NIMBLE's MRI skeleton: every hand pose is a set of named joint angles with
real ranges, and only those angles reach the model.

- Axes come from NIMBLE's own bones: the MCPs flex about the axis across the finger in the palm's plane
  and spread about the one perpendicular to it; the PIPs, DIPs and the thumb's MCP and IP flex about
  the long axis of the head of the bone before them (their elliptical condyles), which is what makes
  flexed fingers converge. The thumb's base (CMC)
  has two separate, non-perpendicular axes (Hollister et al. 1992): flexion-extension about an axis
  close to the palm normal, abduction about one in the palm plane across the metacarpal, and the
  metacarpal rolls into opposition (internal rotation) as it flexes (Crisco et al. 2015).
- Angles are anatomical: 0 = straight, positive = flexion / abduction. NIMBLE's zero pose is a relaxed
  MRI hand, so each joint's rest angle is measured from the bones and subtracted.
- Ranges are in moonshot/body/data/anatomy.json (sources there). They are hard bounds: a pose outside them
  cannot be made (`clamp`), and the solvers search inside them.
- Coupling (`couple`): the DIP follows the PIP per finger, differently in free motion and in contact
  (Roda-Sales et al. 2022), palm cupping (CMC4/5) follows ring flexion (El-Shennawy et al. 2001), and the
  thumb metacarpal rolls into opposition as it flexes (Crisco et al. 2015).

    hand = AnatomicalHand(Nimble(folder), scale=1.12)
    q = hand.neutral()                         # dict joint -> degrees
    pose = hand.nimble_pose(q)                 # (20, 3) axis-angle for Nimble.forward
"""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

from moonshot.body.nimble import BONES, JOINTS, Nimble, rodrigues

ANATOMY = Path(__file__).resolve().parent / "data" / "anatomy.json"

FINGERS = {2: "index", 3: "middle", 4: "ring", 5: "little"}
# joint indices in NIMBLE's 25 (see nimble.JOINTS): base of metacarpal, MCP, PIP, DIP, tip
CHAIN = {1: (1, 2, 3, None, 4), 2: (5, 6, 7, 8, 9), 3: (10, 11, 12, 13, 14), 4: (15, 16, 17, 18, 19),
         5: (20, 21, 22, 23, 24)}


def unit(v):
    v = np.asarray(v, dtype=np.float64)
    return v / np.linalg.norm(v)


def signed_angle(a, b, axis):
    """Angle from a to b about axis (both projected onto the plane normal to it), degrees."""
    axis = unit(axis)
    a = a - axis * a.dot(axis)
    b = b - axis * b.dot(axis)
    return np.degrees(np.arctan2(np.cross(a, b).dot(axis), a.dot(b)))


def condyle_axis(bone_v: np.ndarray, base: np.ndarray, head: np.ndarray) -> np.ndarray:
    """Mediolateral axis of a bone's head (its distal quarter, the long axis projected out, first
    principal direction): the axis the next joint flexes about, from the bone's own shape."""
    u = unit(head - base)
    s = (bone_v - base) @ u
    L = s.max()
    h = bone_v[s > 0.75 * L]
    h = h - h.mean(0)
    h = h - np.outer(h @ u, u)
    _, _, vt = np.linalg.svd(h, full_matrices=False)
    return unit(vt[0])


class AnatomicalHand:
    def __init__(self, model: Nimble, scale: float = 1.12, anatomy: Path = ANATOMY):
        self.model = model
        self.scale = scale
        self.spec = json.loads(Path(anatomy).read_text())
        v, J = model.shaped()
        self.rest_v, self.rest_J = v, J                     # model units (mm, unscaled)
        self._frames()
        self._dofs()

    # --- anatomy from the bones ----------------------------------------------------------------
    def bone_verts(self, joint: int) -> np.ndarray:
        """Rest vertices of the bone that rotates at `joint` (bones are rigidly skinned to it)."""
        m = self.model
        w = m.sw[:m.bone_sep, joint]
        return self.rest_v[:m.bone_sep][w > 0.99]

    def _frames(self):
        J = self.rest_J
        # palm: the plane through the wrist and the index and little MCPs; palmar = the side the
        # relaxed fingers curl toward
        n = unit(np.cross(J[6] - J[0], J[21] - J[0]))
        tip_side = (J[9] - J[6]).dot(n)
        self.palmar = n if tip_side > 0 else -n
        self.long = unit(J[11] - J[0])                       # wrist toward the middle MCP
        self.radial = unit(np.cross(self.long, self.palmar))  # toward the thumb side
        if (J[2] - J[0]).dot(self.radial) < 0:
            self.radial = -self.radial
        self.flex_axis, self.abd_axis = {}, {}
        tilt = self.spec["coupling"]["flex_tilt_deg"]
        for f in (2, 3, 4, 5):
            base, mcp, pip, dip, tip = CHAIN[f]
            # flexion axis: across the finger, in the palm's plane (a nearly straight MRI finger gives
            # no usable plane of its own), tilted so flexed fingers converge toward the thumb's base
            d = unit(J[pip] - J[mcp])
            ax = unit(np.cross(d, self.palmar))
            ax = rodrigues(d * np.radians(tilt[FINGERS[f]]))[0] @ ax
            self.flex_axis[f] = ax
            ab = unit(np.cross(d, ax))                       # spreads toward ...
            if np.cross(ab, d).dot(self.radial) < 0:        # +abduction = toward the thumb side
                ab = -ab
            self.abd_axis[f] = ab
            # PIP and DIP: about the heads of the proximal and middle phalanges (elliptical condyles)
            for joint, (b0, b1) in (("pip", (mcp, pip)), ("dip", (pip, dip))):
                a = condyle_axis(self.bone_verts(b0), J[b0], J[b1])
                child = unit(J[{"pip": dip, "dip": tip}[joint]] - J[b1])
                if np.cross(a, child).dot(self.palmar) < 0:
                    a = -a
                self.flex_axis[(f, joint)] = a
        # thumb
        cmc, mcp, ip, _, tip = CHAIN[1]
        d1 = unit(J[mcp] - J[cmc])
        P = J[[cmc, mcp, ip, tip]]
        _, _, vt = np.linalg.svd(P - P.mean(0))
        tax = unit(vt[2])
        toward_palm = unit(J[11] - J[tip])
        if np.cross(tax, unit(J[ip] - J[mcp])).dot(toward_palm) < 0:
            tax = -tax
        self.thumb_flex_axis = tax                            # fallback (plane of the thumb)
        self.thumb_axes = {}
        for joint, (b0, b1, c) in (("mcp", (cmc, mcp, ip)), ("ip", (mcp, ip, tip))):
            a = condyle_axis(self.bone_verts(b0), J[b0], J[b1])
            if np.cross(a, unit(J[c] - J[b1])).dot(toward_palm) < 0:
                a = -a
            self.thumb_axes[joint] = a
        self.thumb_mcp_abd_axis = unit(np.cross(unit(J[ip] - J[mcp]), tax))
        # CMC flexion-extension: about an axis near the palm normal, tilted toward the metacarpal's
        # own plane (non-perpendicular to the abduction axis, as Hollister found)
        cf = unit(self.palmar + 0.25 * self.long)
        if np.cross(cf, d1).dot(-self.radial) < 0:           # +flexion moves the thumb across the palm
            cf = -cf
        self.cmc_flex_axis = cf
        ca = unit(np.cross(d1, self.palmar))                  # +abduction lifts it out of the palm plane
        if np.cross(ca, d1).dot(self.palmar) < 0:
            ca = -ca
        self.cmc_abd_axis = ca
        self.cmc_roll_axis = d1                               # metacarpal's own long axis

    def _dofs(self):
        """Every degree of freedom: name, bone, rest-frame axis, rest angle, anatomical range."""
        J = self.rest_J
        R = dict(self.spec["ranges_deg"])
        for f, nm in FINGERS.items():
            R[f"{nm}_pip"] = self.spec["per_finger_deg"].get(f"{nm}_pip", R["pip"])
            R[f"{nm}_dip"] = self.spec["per_finger_deg"].get(f"{nm}_dip", R["dip"])
        self.dofs = []

        def add(name, bone, axis, rest, rng):
            self.dofs.append(dict(name=name, bone=BONES.index(bone), axis=unit(axis), rest=float(rest),
                                  lo=float(rng[0]), hi=float(rng[1])))

        for f in (2, 3, 4, 5):
            nm = FINGERS[f]
            base, mcp, pip, dip, tip = CHAIN[f]
            met, pro, mid, dis = (unit(J[b] - J[a]) for a, b in ((base, mcp), (mcp, pip), (pip, dip), (dip, tip)))
            fx, ab = self.flex_axis[f], self.abd_axis[f]
            # CMC (metacarpal on the carpus): cupping, only ring and little move much
            add(f"cmc{f}_flex", f"met{f}", fx, 0.0, R[f"cmc{f}_flex"])
            add(f"{nm}_mcp_abd", f"pro{f}", ab, signed_angle(met, pro, ab), R[f"{nm}_mcp_abd"])
            add(f"{nm}_mcp_flex", f"pro{f}", fx, signed_angle(met, pro, fx), R[f"{nm}_mcp_flex"])
            ap, ad = self.flex_axis[(f, "pip")], self.flex_axis[(f, "dip")]
            add(f"{nm}_pip", f"int{f}", ap, signed_angle(pro, mid, ap), R[f"{nm}_pip"])
            add(f"{nm}_dip", f"dis{f}", ad, signed_angle(mid, dis, ad), R[f"{nm}_dip"])
        cmc, mcp, ip, _, tip = CHAIN[1]
        met, pro, dis = (unit(J[b] - J[a]) for a, b in ((cmc, mcp), (mcp, ip), (ip, tip)))
        # thumb CMC angles are measured from the relaxed MRI pose (the literature's arcs, centred on
        # the relaxed thumb as anatomy.json notes)
        add("thumb_cmc_abd", "met1", self.cmc_abd_axis, 0.0, R["thumb_cmc_abd"])
        add("thumb_cmc_flex", "met1", self.cmc_flex_axis, 0.0, R["thumb_cmc_flex"])
        add("thumb_cmc_roll", "met1", self.cmc_roll_axis, 0.0, R["thumb_cmc_roll"])
        am, ai = self.thumb_axes["mcp"], self.thumb_axes["ip"]
        add("thumb_mcp_abd", "pro1", unit(np.cross(pro, am)), 0.0, R["thumb_mcp_abd"])
        add("thumb_mcp_flex", "pro1", am, signed_angle(met, pro, am), R["thumb_mcp_flex"])
        add("thumb_ip", "dis1", ai, signed_angle(pro, dis, ai), R["thumb_ip"])
        self.index = {d["name"]: i for i, d in enumerate(self.dofs)}
        self.names = [d["name"] for d in self.dofs]
        self.lo = np.array([d["lo"] for d in self.dofs])
        self.hi = np.array([d["hi"] for d in self.dofs])
        self.rest = np.array([d["rest"] for d in self.dofs])

    # --- poses ---------------------------------------------------------------------------------
    def neutral(self) -> dict:
        """The relaxed MRI hand, in anatomical angles."""
        return {d["name"]: d["rest"] for d in self.dofs}

    def vector(self, q: dict) -> np.ndarray:
        return np.array([q.get(n, self.rest[i]) for i, n in enumerate(self.names)], dtype=np.float64)

    def as_dict(self, v) -> dict:
        return {n: float(x) for n, x in zip(self.names, v)}

    def couple(self, q: dict, contact: set | None = None, set_: set | None = None) -> dict:
        """Apply the couplings to every angle not explicitly set (`set_`, default: the keys of q that
        are not DIPs or CMCs):
        - DIP from PIP, per finger (Roda-Sales et al. 2022): free motion dip = k*pip, in contact
          (`contact` holds finger names) dip = k*pip + c;
        - palm cupping: CMC4 from ring MCP flexion, CMC5 from CMC4 (El-Shennawy et al. 2001: CMC5
          loses 40% of its range when CMC4 is fixed);
        - thumb CMC roll into opposition, 0.36 deg per deg of CMC flexion (Crisco et al. 2015)."""
        q = dict(q)
        C = self.spec["coupling"]
        contact = contact or set()
        given = set_ if set_ is not None else {k for k in q if not k.endswith("_dip") and not k.startswith("cmc")
                                                and k != "thumb_cmc_roll"}
        for f, nm in FINGERS.items():
            pip = q.get(f"{nm}_pip", self.rest[self.index[f"{nm}_pip"]])
            if f"{nm}_dip" not in given:
                if nm in contact:
                    k, c = C["dip_per_pip_contact"][nm]
                    q[f"{nm}_dip"] = k * pip + c
                else:
                    q[f"{nm}_dip"] = C["dip_per_pip_free"][nm] * pip
        if "cmc4_flex" not in given:
            q["cmc4_flex"] = C["cmc4_per_mcp"] * max(0.0, q.get("ring_mcp_flex", 0.0))
        if "cmc5_flex" not in given:
            q["cmc5_flex"] = C["cmc5_per_cmc4"] * q["cmc4_flex"]
        if "thumb_cmc_roll" not in given:
            q["thumb_cmc_roll"] = C["thumb_roll_per_cmc_flex"] * q.get("thumb_cmc_flex", 0.0)
        return self.clamp(q)

    def mcp_abd_limit(self, nm: str, flex: float) -> tuple[float, float]:
        """MCP abduction narrows as the MCP flexes (collateral ligaments tighten)."""
        lo, hi = self.lo[self.index[f"{nm}_mcp_abd"]], self.hi[self.index[f"{nm}_mcp_abd"]]
        k = max(0.0, 1 - max(0.0, flex) / 90.0 * self.spec["coupling"]["mcp_abd_loss_at_90"])
        return lo * k, hi * k

    def clamp(self, q: dict) -> dict:
        out = {}
        for i, n in enumerate(self.names):
            x = q.get(n, self.rest[i])
            lo, hi = self.lo[i], self.hi[i]
            if n.endswith("_mcp_abd"):
                lo, hi = self.mcp_abd_limit(n.split("_")[0], q.get(n.replace("abd", "flex"), 0.0))
            out[n] = float(min(hi, max(lo, x)))
        return out

    def violations(self, q: dict, tol: float = 0.5) -> list[str]:
        bad = []
        for i, n in enumerate(self.names):
            x = q.get(n, self.rest[i])
            lo, hi = self.lo[i], self.hi[i]
            if n.endswith("_mcp_abd"):
                lo, hi = self.mcp_abd_limit(n.split("_")[0], q.get(n.replace("abd", "flex"), 0.0))
            if x < lo - tol or x > hi + tol:
                bad.append(f"{n}={x:.1f} not in [{lo:.1f}, {hi:.1f}]")
        return bad

    def bone_rotations(self, q: dict) -> np.ndarray:
        """(20, 3, 3) parent-relative rotations in NIMBLE's rest axes. Per bone, its DOFs compose in
        listed order (abduction before flexion, as the finger spreads then bends about its own axis)."""
        R = np.repeat(np.eye(3)[None], 20, 0)
        for i, d in enumerate(self.dofs):
            delta = q.get(d["name"], d["rest"]) - d["rest"]
            if abs(delta) < 1e-9:
                continue
            R[d["bone"]] = R[d["bone"]] @ rodrigues(d["axis"] * np.radians(delta))[0]
        return R

    def nimble_pose(self, q: dict) -> np.ndarray:
        from moonshot.body.nimble import mat_to_aa
        return mat_to_aa(self.bone_rotations(q))

    # --- geometry ----------------------------------------------------------------------------
    def forward(self, q: dict, collision: bool = False, smooth: bool = False):
        """Posed model (scaled to `scale`, mm) in the hand's own frame (origin at the wrist joint)."""
        from moonshot.body.nimble import taubin
        o = self.model.forward(self.nimble_pose(q), shaped=(self.rest_v, self.rest_J))
        skin = o["skin"]
        if collision:
            skin = self.model.push_skin_out_of_muscle(skin, o["muscle"])
        if smooth:
            skin = taubin(skin, self.model.skin_f)
        c = self.rest_J[0]
        s = self.scale
        return {k: (o[k] - c) * s for k in ("bone", "muscle", "joints")} | {"skin": (skin - c) * s, "G": o["G"]}

    def wrist_frame(self) -> np.ndarray:
        """Hand frame axes in NIMBLE rest coordinates: columns x = long (toward fingers),
        y = radial (thumb side), z = dorsal."""
        x = self.long
        y = unit(self.radial - x * self.radial.dot(x))
        z = np.cross(x, y)
        return np.stack([x, y, z], 1)
