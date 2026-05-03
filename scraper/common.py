"""Shared HTTP fetching, rate limiting, and on-disk caching for UBC scrapers."""
from __future__ import annotations

import asyncio
import hashlib
import logging
import time
from pathlib import Path
from urllib.parse import urlparse

import httpx
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

BASE_URL = "https://vancouver.calendar.ubc.ca"
USER_AGENT = (
    "UBCLLM-Scraper/0.1 (educational; "
    "https://github.com/maxlbchung/ubcllm; contact: maxlbchung@gmail.com)"
)
DEFAULT_TIMEOUT = httpx.Timeout(30.0, connect=10.0)

CACHE_DIR = Path(__file__).parent / "cache"
OUTPUT_DIR = Path(__file__).parent / "output"

log = logging.getLogger("ubcllm.scraper")


def cache_path_for(url: str) -> Path:
    """Map a URL to a deterministic file in CACHE_DIR."""
    parsed = urlparse(url)
    safe = (parsed.path.strip("/") or "index").replace("/", "__")
    digest = hashlib.sha1(url.encode("utf-8")).hexdigest()[:10]
    return CACHE_DIR / f"{safe}_{digest}.html"


class RateLimitedClient:
    """httpx.AsyncClient wrapper that enforces a minimum gap between requests
    and retries transient failures with exponential backoff.
    """

    def __init__(self, client: httpx.AsyncClient, min_interval: float = 1.0):
        self._client = client
        self._min_interval = min_interval
        self._last_request = 0.0
        self._lock = asyncio.Lock()

    async def _throttle(self) -> None:
        async with self._lock:
            wait = self._min_interval - (time.monotonic() - self._last_request)
            if wait > 0:
                await asyncio.sleep(wait)
            self._last_request = time.monotonic()

    @retry(
        stop=stop_after_attempt(4),
        wait=wait_exponential(multiplier=2, min=2, max=30),
        retry=retry_if_exception_type(
            (httpx.HTTPError, httpx.TimeoutException)
        ),
        reraise=True,
    )
    async def _get_raw(self, url: str) -> str:
        await self._throttle()
        log.info("GET %s", url)
        resp = await self._client.get(url)
        resp.raise_for_status()
        return resp.text

    async def get_html(self, url: str, *, force: bool = False) -> str:
        """Fetch a page, using the on-disk cache unless force=True."""
        cache_file = cache_path_for(url)
        if cache_file.exists() and not force:
            return cache_file.read_text(encoding="utf-8")
        html = await self._get_raw(url)
        cache_file.parent.mkdir(parents=True, exist_ok=True)
        cache_file.write_text(html, encoding="utf-8")
        return html


def make_async_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        headers={"User-Agent": USER_AGENT, "Accept": "text/html"},
        timeout=DEFAULT_TIMEOUT,
        follow_redirects=True,
    )


def configure_logging(verbose: bool = False) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
        datefmt="%H:%M:%S",
    )
