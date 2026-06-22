/**
 * Minimal ambient types for `online-3d-viewer` (v0.18). The package ships a
 * d.ts at build/engine/o3dv.module.d.ts but declares no `types`/`exports` entry,
 * so TypeScript can't resolve it from a bare `import * as OV from 'online-3d-viewer'`.
 * We declare only the surface we use (the embedded STEP viewer). The engine
 * fetches occt-import-js from the jsdelivr CDN at runtime (no self-hosting).
 */
declare module 'online-3d-viewer' {
  export class EmbeddedViewer {
    constructor(
      parentElement: HTMLElement,
      parameters?: {
        backgroundColor?: unknown;
        onModelLoaded?: () => void;
        onModelLoadFailed?: (...args: unknown[]) => void;
        [key: string]: unknown;
      },
    );
    /** Load a model from a list of URLs (main file + any referenced files). */
    LoadModelFromUrlList(modelUrls: string[]): void;
    /** Load a model from picked File objects. */
    LoadModelFromFileList(fileList: File[]): void;
    /** Re-fit the canvas after the parent element resizes. */
    Resize(): void;
    /** Free the WebGL context and DOM nodes. Call on unmount. */
    Destroy(): void;
  }
}
