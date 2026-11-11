class BlockedError(Exception):
    """A CAPTCHA or bot block was detected. The job stops and becomes BLOCKED."""

    def __init__(self, message: str, url: str):
        super().__init__(message)
        self.message = message
        self.url = url


class SearchDisallowedError(Exception):
    """robots.txt forbids the search page. No request to it was made."""

    def __init__(self, url: str):
        super().__init__(f"robots.txt does not allow automated access to {url}")
        self.url = url
