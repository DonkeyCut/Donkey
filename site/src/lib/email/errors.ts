// Thrown by a builder when the email can never go out as queued: the row is
// given up without a retry and the message lands on it.
export class PermanentSendError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "PermanentSendError";
  }
}
