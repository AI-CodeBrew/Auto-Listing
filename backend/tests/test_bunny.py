"""Photos and videos on Bunny Storage, against a mock of its Storage API on this computer.
No real Bunny key or zone is used."""
from __future__ import annotations

import json
import os
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote

import pytest
from fastapi.testclient import TestClient

from pla import repo, storage
from pla.storage import clear_research_files, ensure_dirs, ensure_local, media_path, public_url, publish_files

KEY = "mock-bunny-key"
CDN = "https://cdn.example.test"


class _Bunny(BaseHTTPRequestHandler):
    files: dict[str, bytes] = {}

    def log_message(self, *args):  # quiet
        pass

    def _path(self) -> str | None:
        if self.headers.get("AccessKey") != KEY:
            self.send_response(401)
            self.end_headers()
            return None
        return unquote(self.path).lstrip("/")

    def do_PUT(self):
        path = self._path()
        if path is None:
            return
        self.files[path] = self.rfile.read(int(self.headers["Content-Length"]))
        self.send_response(201)
        self.end_headers()

    def do_GET(self):
        path = self._path()
        if path is None:
            return
        if path.endswith("/"):
            names = sorted({p[len(path):].split("/")[0] for p in self.files if p.startswith(path)})
            body = json.dumps([{"ObjectName": n, "IsDirectory": "/" in next(p[len(path):] for p in self.files if p.startswith(path + n))} for n in names]).encode()
        elif path in self.files:
            body = self.files[path]
        else:
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_DELETE(self):
        path = self._path()
        if path is None:
            return
        self.send_response(200 if self.files.pop(path, None) is not None else 404)
        self.end_headers()


@pytest.fixture
def bunny(monkeypatch):
    _Bunny.files = {}
    server = ThreadingHTTPServer(("127.0.0.1", 0), _Bunny)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    monkeypatch.setenv("BUNNY_STORAGE_ZONE", "zone")
    monkeypatch.setenv("BUNNY_STORAGE_KEY", KEY)
    monkeypatch.setenv("BUNNY_STORAGE_HOST", f"http://127.0.0.1:{server.server_address[1]}")
    monkeypatch.setenv("BUNNY_CDN_URL", CDN + "/")
    yield _Bunny.files
    server.shutdown()


def _write(product_id: str, kind: str, name: str, data: bytes = b"photo-bytes") -> str:
    ensure_dirs(product_id)
    path = media_path(product_id, kind, name)
    with open(path, "wb") as handle:
        handle.write(data)
    return path


def test_without_bunny_files_stay_local():
    product_id = str(uuid.uuid4())
    path = _write(product_id, "images", "a.jpg")
    publish_files(product_id)
    assert os.path.exists(path)
    assert public_url(product_id, "images", "a.jpg") is None


def test_publish_moves_finished_files_and_brings_them_back(bunny):
    product_id = str(uuid.uuid4())
    photo = _write(product_id, "images", "a.jpg", b"jpeg-1")
    video = _write(product_id, "videos", "v.mp4", b"mp4-1")
    partial = _write(product_id, "images", "tmp-123.part", b"half")

    publish_files(product_id)
    assert bunny[f"zone/{product_id}/images/a.jpg"] == b"jpeg-1"
    assert bunny[f"zone/{product_id}/videos/v.mp4"] == b"mp4-1"
    assert not os.path.exists(photo) and not os.path.exists(video)  # nothing left on the server
    assert os.path.exists(partial) and not any(k.endswith(".part") for k in bunny)  # unfinished files stay

    assert public_url(product_id, "images", "a.jpg") == f"{CDN}/{product_id}/images/a.jpg"
    back = ensure_local(product_id, "images", "a.jpg")
    with open(back, "rb") as handle:
        assert handle.read() == b"jpeg-1"


def test_new_research_removes_old_files_on_bunny_but_keeps_uploads(bunny):
    product_id = str(uuid.uuid4())
    _write(product_id, "images", "upload.jpg")
    _write(product_id, "images", "found.jpg")
    publish_files(product_id)
    clear_research_files(product_id, keep=["upload.jpg"])
    assert f"zone/{product_id}/images/upload.jpg" in bunny
    assert f"zone/{product_id}/images/found.jpg" not in bunny


def test_wrong_key_is_an_error(bunny, monkeypatch):
    monkeypatch.setenv("BUNNY_STORAGE_KEY", "wrong")
    product_id = str(uuid.uuid4())
    path = _write(product_id, "images", "a.jpg")
    with pytest.raises(storage.bunny.BunnyError):
        publish_files(product_id)
    assert os.path.exists(path)  # nothing is deleted when the upload fails


def test_files_route_sends_bunny_files_to_the_cdn(bunny, monkeypatch):
    from pla.api import create_app

    client = TestClient(create_app(), base_url="http://localhost")
    email = f"bunny-{uuid.uuid4().hex[:8]}@test.local"
    me = client.post("/api/auth/signup", json={"name": "Bunny", "email": email, "password": "password123"}).json()
    product_id = str(uuid.uuid4())
    repo.create_product_with_job(id=product_id, name="CDN bottle", owner_id=me["user"]["id"])
    _write(product_id, "images", "a.jpg")
    publish_files(product_id)

    response = client.get(f"/api/files/{product_id}/images/a.jpg", follow_redirects=False)
    assert response.status_code == 302
    assert response.headers["location"] == f"{CDN}/{product_id}/images/a.jpg"
    assert client.get(f"/api/files/{product_id}/images/missing.jpg", follow_redirects=False).headers["location"].endswith("/missing.jpg")


def test_shopify_gets_photo_addresses_instead_of_uploads(bunny, monkeypatch):
    from pla.shopify import send

    product_id = str(uuid.uuid4())
    repo.create_product_with_job(id=product_id, name="CDN bottle")
    repo.update_product(product_id, {"stage": "listing", "name": "CDN bottle", "shopify_handle": "cdn-bottle", "price": "10.00"})
    _write(product_id, "images", "a.jpg")
    publish_files(product_id)
    repo.add_image({
        "product_id": product_id, "file_name": "a.jpg", "source_url": None, "source_page": None, "width": 800, "height": 800,
        "bytes": 10, "phash": None, "passed": True, "reason": None, "checks": {}, "uploaded": True,
    })
    image_id = repo.list_images(product_id)[0]["id"]
    repo.set_image_order(product_id, [image_id])

    sent: dict = {}

    def fake_graphql(query, variables, timeout_ms=0):
        if "productByIdentifier" in query:
            return {"productByIdentifier": None}
        if "productSet" in query:
            sent.update(variables["input"])
            return {"productSet": {"product": {"id": "gid://shopify/Product/1", "status": "DRAFT", "handle": "cdn-bottle"}, "userErrors": []}}
        return {"product": {"media": {"nodes": []}}}

    uploaded: list = []
    monkeypatch.setattr(send, "graphql", fake_graphql)
    monkeypatch.setattr(send, "_upload_files", lambda files: uploaded.extend(files) or [])
    monkeypatch.setattr(send, "_page_text", lambda product, warnings: None)
    send._run_send(product_id)

    assert uploaded == []  # nothing uploaded from this server
    assert sent["files"] == [{"originalSource": f"{CDN}/{product_id}/images/a.jpg", "contentType": "IMAGE", "alt": "CDN bottle"}]
