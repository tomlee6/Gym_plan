/**
 * Parts are missing, or the assembled file is not the size it was opened
 * with. [missing] lists the part numbers the app should send again.
 */
export class StorageIncomplete extends Error {
  constructor(message, missing = []) {
    super(message);
    this.missing = missing;
  }
}
