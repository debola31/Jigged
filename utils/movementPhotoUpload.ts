/**
 * Upload the photo attached to a stock movement, and own the one message a failure produces.
 *
 * ## Why this is a module and not two copies
 *
 * Two surfaces record a movement at a bin: `OperatorLocationActionModal` (Add / Remove / Move /
 * Adjust on a part already there) and `OperatorReceivePartModal` ("Stock a part", the only path for
 * a part that is not in the bin yet). Only the first ever offered a photo, so the FIRST time a part
 * landed anywhere there was no photo and every top-up afterwards had one — which is precisely
 * backwards, since the first drop is the one nobody else has seen yet.
 *
 * Fixing that means both modals run the same three steps in the same order, so they live here once
 * rather than being written twice and drifting.
 *
 * ## The order is load-bearing
 *
 * Upload BEFORE the RPC. `inventory_transactions.photo_path` is written at INSERT and is immutable
 * afterwards (`restrict_transaction_update_to_notes`), so there is no second step in which to
 * attach a path — the RPC has to be handed one. The cost is that a failed write leaves an orphaned
 * object in the bucket; the alternative — insert, upload, then UPDATE the path — needs the column
 * to stay mutable, and evidence that can be swapped later is not evidence.
 *
 * ## Why the message lives here
 *
 * A failed upload must ABORT the write and say so in its own words. Left to the shared mapper it
 * renders as "Failed to update stock", which points at the quantity — so an operator retypes a
 * number that was never the problem, on a shop-wifi upload that just needs trying again.
 *
 * `MovementPhotoUploadError` is a bare `Error` subclass with no `code`, which is exactly what
 * `ErrorAlert`'s `isHandWrittenMessage` looks for: it renders `.message` verbatim instead of
 * translating it. `OperatorReceivePartModal` reads `.message` directly for the same result. So both
 * callers can let this propagate to the catch they already have.
 *
 * Note this deliberately does NOT re-classify a billing-blocked upload. A lapsed subscription
 * produces a nameless row-level-security message from Storage that `isBillingWriteBlocked` cannot
 * tell from a real permission failure, and the previous hand-rolled version of this message was a
 * plain string, which bypassed that classification too. Behaviour is unchanged; only the
 * duplication is gone.
 */
import { generateStoragePath, uploadFileToStorage } from '@/utils/storageHelpers';

/** A failed movement-photo upload, carrying the sentence the operator should read. */
export class MovementPhotoUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MovementPhotoUploadError';
  }
}

/**
 * Put the photo in the bucket and return its path, for the caller to hand to the stock RPC.
 *
 * Filed under the LOCATION id rather than the transaction's: the row does not exist yet at upload
 * time, and grouping by place is the useful fallback when someone has to go looking in the bucket.
 */
export async function uploadMovementPhoto(
  companyId: string,
  locationId: string,
  file: File,
): Promise<string> {
  const path = generateStoragePath(companyId, 'inventory-transactions', locationId, file.name);
  try {
    await uploadFileToStorage(path, file);
  } catch (e) {
    throw new MovementPhotoUploadError(
      `Couldn't upload the photo (${
        e instanceof Error ? e.message : 'unknown error'
      }). Nothing was recorded — try again, or remove the photo and save.`,
    );
  }
  return path;
}
