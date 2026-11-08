/** A CAPTCHA or bot block was detected. The job stops and becomes BLOCKED. */
export class BlockedError extends Error {
  constructor(
    message: string,
    public readonly url: string,
  ) {
    super(message);
    this.name = "BlockedError";
  }
}

/** robots.txt forbids the search page. No request to it was made. */
export class SearchDisallowedError extends Error {
  constructor(public readonly url: string) {
    super(`robots.txt does not allow automated access to ${url}`);
    this.name = "SearchDisallowedError";
  }
}
