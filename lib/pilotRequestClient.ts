import type { PilotRequestInput } from '@/lib/pilotRequest';

/**
 * Thin browser client for a showcase pilot request, in three calls:
 *
 *   createPilotRequest   POST /pilot-requests            → a request id and a signed upload URL
 *   uploadPilotFile      PUT  the signed URL, with progress (XMLHttpRequest — fetch has no upload
 *                        progress, and supabase-js's uploadToSignedUrl is built on fetch)
 *   completePilotRequest POST /pilot-requests/complete   → the server checks the file arrived
 *
 * Same shape as lib/legal/acceptClient.ts: the Route Handler is the access layer here, so this
 * file only speaks HTTP to it. Deliberately does not import lib/supabase — the showcase is a
 * public page read on phones, and the browser Supabase client is weight it does not need.
 */

export type PilotStage = 'create' | 'upload' | 'complete';

export class PilotRequestError extends Error {
  constructor(
    message: string,
    readonly stage: PilotStage,
    /** HTTP status, or 0 when the request never got an answer (offline, stalled, aborted). */
    readonly status: number,
  ) {
    super(message);
    this.name = 'PilotRequestError';
  }

  /**
   * Whether Sentry should hear about it. Not the visitor's own connection (status 0) and not our
   * rate limit doing its job (429): neither has a code fix. Everything else — a 5xx, a storage
   * refusal, a 400 the shared validator should have prevented — is a bug, and a prospect who
   * could not reach us.
   */
  get reportable(): boolean {
    return this.status !== 0 && this.status !== 429;
  }
}

export interface PilotUpload {
  url: string;
  content_type: string;
}

export interface PilotRequestCreated {
  /** Null, with `upload`, when the server took the submission for a script's. */
  request_id: string | null;
  upload: PilotUpload | null;
}

const CONNECTION_MESSAGE = "We couldn't reach Jigged. Check your connection and try again.";
const GENERIC_MESSAGE = "Something went wrong sending your part. Please try again.";

async function postJson(path: string, body: unknown, stage: PilotStage): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new PilotRequestError(CONNECTION_MESSAGE, stage, 0);
  }
  const json = (await res.json().catch(() => null)) as { error?: unknown } | null;
  if (!res.ok) {
    // Our own routes word their 4xx for the visitor; a 5xx keeps the generic line.
    const message =
      res.status < 500 && typeof json?.error === 'string' ? json.error : GENERIC_MESSAGE;
    throw new PilotRequestError(message, stage, res.status);
  }
  return json;
}

export async function createPilotRequest(
  input: Omit<PilotRequestInput, 'file_type'> & { website: string },
): Promise<PilotRequestCreated> {
  return (await postJson('/pilot-requests', input, 'create')) as PilotRequestCreated;
}

export async function completePilotRequest(requestId: string): Promise<void> {
  await postJson('/pilot-requests/complete', { request_id: requestId }, 'complete');
}

/**
 * No progress event for this long means the transfer has stalled. Measured from the LAST byte
 * moved rather than from the start, so a slow-but-steady link is never cut off mid-file and a
 * dead one is given up on within a minute rather than after a size-scaled budget.
 */
const UPLOAD_STALL_MS = 60_000;

/**
 * PUT the file to the signed URL. Raw body with an explicit Content-Type — the one the server
 * chose — because a multipart body would carry the File's own type, which for CAD is whatever
 * the OS guessed and the bucket would refuse. `x-upsert: false` so a path is written once.
 *
 * A "duplicate" answer counts as success: it means an earlier attempt landed and only its
 * response was lost, and the complete step checks the file is really there either way.
 */
export function uploadPilotFile(
  upload: PilotUpload,
  file: Blob,
  onProgress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let stalled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const armStallTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stalled = true;
        xhr.abort();
      }, UPLOAD_STALL_MS);
    };

    xhr.open('PUT', upload.url);
    xhr.setRequestHeader('content-type', upload.content_type);
    xhr.setRequestHeader('x-upsert', 'false');
    // What supabase-js sends with every Storage call; the publishable key, not a secret.
    const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (publishableKey) xhr.setRequestHeader('apikey', publishableKey);

    xhr.upload.onprogress = (event) => {
      armStallTimer();
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };

    xhr.onload = () => {
      clearTimeout(timer);
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve();
        return;
      }
      let body: { statusCode?: unknown; error?: unknown } | null = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // not JSON — fall through on the status alone
      }
      // Storage has answered a duplicate both as HTTP 409 and as HTTP 400 with statusCode "409".
      if (xhr.status === 409 || String(body?.statusCode) === '409' || body?.error === 'Duplicate') {
        onProgress(1);
        resolve();
        return;
      }
      const tooLarge = xhr.status === 413 || String(body?.statusCode) === '413';
      reject(
        new PilotRequestError(
          tooLarge ? 'That file is too large to send.' : GENERIC_MESSAGE,
          'upload',
          xhr.status,
        ),
      );
    };
    xhr.onerror = () => {
      clearTimeout(timer);
      reject(new PilotRequestError(CONNECTION_MESSAGE, 'upload', 0));
    };
    xhr.onabort = () => {
      clearTimeout(timer);
      reject(
        new PilotRequestError(
          stalled ? 'The upload stopped moving. Check your connection and try again.' : CONNECTION_MESSAGE,
          'upload',
          0,
        ),
      );
    };

    armStallTimer();
    xhr.send(file);
  });
}
