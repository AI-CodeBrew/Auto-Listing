"""The same checks the old TypeScript unit tests made, now against the Python backend."""
from __future__ import annotations

import base64
import io
import json

import pytest
from PIL import Image, ImageDraw

from pla.costs import money, price_usage
from pla.media.images import hamming_distance, perceptual_hash
from pla.pipeline.text import choose_best_images, find_copied_phrases, finalize_listing, remove_store_words
from pla.sanitize import description_to_html, to_plain_text
from pla.search.bing import unwrap_bing_link
from pla.search.fastmoss import video_search_arguments, videos_from_payload
from pla.search.marketplaces import marketplace_of_hit, take_marketplace_photos
from pla.shopify.send import build_product_input, make_handle, saamano_metafields
from pla.web.extract import full_size_guesses, largest_from_srcset, looks_like_icon_or_logo
from pla.web.net import is_private_address, is_public_url
from pla.web.urls import classify_video, exclusion_reason, filter_product_urls, normalize_url, video_extension


# ---------- video rules ----------

def test_platform_videos_are_links_only():
    for url, provider in [
        ("https://www.youtube.com/embed/abc123", "youtube"),
        ("https://youtu.be/abc123", "youtube"),
        ("https://www.youtube.com/watch?v=abc123&t=3", "youtube"),
        ("https://player.vimeo.com/video/1234567", "vimeo"),
        ("https://www.tiktok.com/@a/video/1.mp4", "tiktok"),
        ("https://www.instagram.com/reel/x/video.mp4", "instagram"),
        ("https://www.facebook.com/x/videos/1.mp4", "facebook"),
        ("https://fb.watch/abc.mp4", "facebook"),
    ]:
        result = classify_video(url)
        assert result and result["kind"] == "link", url
        assert result["provider"] == provider, url


def test_platform_cdn_files_are_refused():
    for url in ["https://rr1.googlevideo.com/x.mp4", "https://v.fbcdn.net/x.mp4", "https://a.cdninstagram.com/x.mp4", "https://v16.tiktokcdn.com/x.mp4"]:
        assert classify_video(url) is None, url


def test_only_direct_video_files():
    assert classify_video("https://shop.example/a.MP4")["kind"] == "file"
    assert classify_video("https://shop.example/a.mov?x=1")["kind"] == "file"
    assert classify_video("https://shop.example/a.webm")["kind"] == "file"
    assert classify_video("https://shop.example/a.m3u8") is None
    assert classify_video("blob:https://shop.example/1") is None


def test_html_at_mp4_url_is_not_video():
    assert video_extension("text/html", "https://a.example/v.mp4") is None
    assert video_extension("video/webm", "https://a.example/v") == "webm"
    assert video_extension("application/octet-stream", "https://a.example/v.mov") == "mov"


# ---------- URL filtering ----------

def test_removes_blogs_social_and_duplicates():
    result = filter_product_urls(
        [
            "https://shop.example/p/1?utm_source=x",
            "https://www.shop.example/p/1/",
            "http://shop.example/p/1#top",
            "https://shop.example/p/2?color=red",
            "https://shop.example/blog/post",
            "https://blog.shop.example/p",
            "https://someone.medium.com/bottles",
            "https://m.facebook.com/x",
            "https://x.com/y",
            "https://www.pinterest.com/pin/1",
        ],
        set(),
    )
    assert result["keep"] == ["https://shop.example/p/1?utm_source=x", "https://shop.example/p/2?color=red"]
    assert len(result["dropped"]) == 6


def test_variants_stay_different():
    assert normalize_url("https://a.example/p?color=red") != normalize_url("https://a.example/p?color=blue")


def test_non_web_urls_are_excluded():
    assert exclusion_reason("javascript:alert(1)")
    assert exclusion_reason("file:///c:/secret")


def _b64url(text: str) -> str:
    return base64.urlsafe_b64encode(text.encode()).decode().rstrip("=")


def test_bing_links_are_decoded():
    target = "https://shop.example/p/1"
    wrapped = f"https://www.bing.com/ck/a?!&&p=abc&u=a1{_b64url(target)}&ntb=1"
    assert unwrap_bing_link(wrapped) == target
    assert unwrap_bing_link("https://www.bing.com/search?q=more") is None
    assert unwrap_bing_link(target) == target
    assert unwrap_bing_link(f"https://www.bing.com/ck/a?u=a1{_b64url('javascript:alert(1)')}") is None


# ---------- untrusted pages cannot reach local services ----------

def test_private_addresses():
    for ip in ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "169.254.169.254", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "0.0.0.0"]:
        assert is_private_address(ip), ip
    for ip in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"]:
        assert not is_private_address(ip), ip


def test_local_urls_are_refused(monkeypatch):
    monkeypatch.delenv("ALLOW_PRIVATE_NETWORK", raising=False)
    assert not is_public_url("http://localhost:3000/api/products")
    assert not is_public_url("http://127.0.0.1:3000/")
    assert not is_public_url("http://[::1]:3000/")
    assert not is_public_url("http://169.254.169.254/latest/meta-data")
    assert not is_public_url("file:///c:/windows/win.ini")


# ---------- image helpers ----------

def test_srcset_picks_largest():
    assert largest_from_srcset("a.jpg 100w, b.jpg 1600w, c.jpg 800w") == "b.jpg"
    assert largest_from_srcset("a.jpg 1x, b.jpg 2x") == "b.jpg"


def test_full_size_guesses():
    assert full_size_guesses("https://cdn.shopify.com/s/files/photo_400x400.jpg?v=1") == ["https://cdn.shopify.com/s/files/photo.jpg?v=1"]
    assert full_size_guesses("https://a.example/wp-content/photo-300x300.jpg") == ["https://a.example/wp-content/photo.jpg"]
    assert full_size_guesses("https://m.media-amazon.com/images/I/abc._AC_SX300_.jpg") == ["https://m.media-amazon.com/images/I/abc.jpg"]
    assert full_size_guesses("https://a.example/photo.jpg?width=200") == ["https://a.example/photo.jpg"]
    assert full_size_guesses("https://a.example/photo.jpg") == []


def test_icons_and_logos():
    for url in ["https://a.example/logo.png", "https://a.example/img/site-logo-2.jpg", "https://a.example/x.svg", "https://a.example/favicon.ico", "https://a.example/icons/cart.png"]:
        assert looks_like_icon_or_logo(url), url
    assert not looks_like_icon_or_logo("https://a.example/product/bottle.jpg")
    assert looks_like_icon_or_logo("https://a.example/p.jpg", "Company logo")


def _picture(top, bottom, shapes) -> Image.Image:
    size = 1600
    image = Image.new("RGB", (size, size))
    draw = ImageDraw.Draw(image)
    for y in range(size):
        t = y / (size - 1)
        draw.line([(0, y), (size, y)], fill=tuple(int(a + (b - a) * t) for a, b in zip(top, bottom)))
    for kind, box, color in shapes:
        (draw.ellipse if kind == "circle" else draw.rectangle)(box, fill=color)
    return image


def _jpeg(image: Image.Image, side: int, quality: int) -> bytes:
    out = io.BytesIO()
    image.resize((side, side)).save(out, "JPEG", quality=quality)
    return out.getvalue()


def test_perceptual_hash():
    picture = _picture((223, 230, 233), (99, 110, 114), [("circle", (180, 280, 1020, 1120), (214, 48, 49)), ("rect", (900, 200, 1300, 1300), (9, 132, 227))])
    different = _picture((45, 52, 54), (255, 234, 167), [("rect", (100, 900, 1400, 1300), (0, 184, 148)), ("circle", (940, 140, 1460, 660), (253, 203, 110))])
    big = perceptual_hash(_jpeg(picture, 1200, 90))
    small = perceptual_hash(_jpeg(picture, 900, 60))
    other = perceptual_hash(_jpeg(different, 1200, 90))
    assert hamming_distance(big, small) <= 6
    assert hamming_distance(big, other) > 6


def test_best_images():
    def image(id_, quality, passed=True, uploaded=False):
        return {"id": id_, "passed": passed, "uploaded": uploaded, "width": 1000, "height": 1000, "checks": {"quality": quality}}

    items = [image("a", 50), image("b", 90), image("fail", 99, False), image("own", 10, True, True), *[image(f"x{i}", 40) for i in range(12)]]
    best = choose_best_images(items, 10)
    assert len(best) == 10
    assert best[:3] == ["own", "b", "a"]
    assert "fail" not in best


# ---------- text rules ----------

DRAFT = {
    "best_name": "ShopMart Steel Bottle | ShopMart",
    "name_options": ["Steel Bottle - ShopMart", "Insulated Bottle", "Steel Bottle"],
    "category": "ShopMart Drinkware",
    "description": "A strong bottle. It is BPA-free and food safe. Rated 4.8 by buyers. Customers love it.",
    "feature_bullets": ["- Dishwasher-safe body", "Steel lid", "4.5 stars overall", "Bestseller in its class"],
    "claims_needing_check": ["food safe"],
}


def test_store_words_reviews_and_claims():
    result = finalize_listing(DRAFT, ["ShopMart"], "fallback")
    assert result["name"] == "Steel Bottle"
    assert result["category"] == "Drinkware"
    assert result["nameOptions"] == ["Insulated Bottle"]
    assert "BPA-free [needs checking]" in result["description"]
    assert "food safe [needs checking]" in result["description"]
    assert "- Dishwasher-safe [needs checking] body" in result["description"]
    assert "- Steel lid" in result["description"]
    for word in ("Rated", "love", "stars", "Bestseller"):
        assert word.lower() not in result["description"].lower()
    assert sorted(c.lower() for c in result["claims"]) == ["bpa-free", "dishwasher-safe", "food safe"]


def test_removing_store_words():
    assert remove_store_words("Target Practice Set - Target", ["Target"]) == "Practice Set"
    assert remove_store_words("Bottle (Amazon)", ["Amazon"]) == "Bottle"
    assert remove_store_words("Steel Bottle", ["Steelworks"]) == "Steel Bottle"


def test_copied_phrases():
    source = "This amazing insulated bottle keeps your drinks perfectly cold for twenty four hours straight."
    assert len(find_copied_phrases("Our bottle keeps your drinks perfectly cold for twenty four hours straight, always.", [source])) == 1
    assert find_copied_phrases("A double-wall flask that stays chilly all day long.", [source]) == []


def test_html_is_removed_and_escaped():
    assert to_plain_text("<p>Hi <b>there</b></p><script>alert(1)</script><style>x{}</style>") == "Hi there"
    assert to_plain_text('<img src=x onerror="alert(1)">Text') == "Text"
    assert description_to_html('Intro <script>alert(1)</script>\n\n- One\n- Two & "three"\n\nOutro') == (
        '<p>Intro &lt;script&gt;alert(1)&lt;/script&gt;</p><ul><li>One</li><li>Two &amp; &quot;three&quot;</li></ul><p>Outro</p>'
    )


# ---------- Shopify input ----------

PRODUCT = {"id": "12345678-aaaa", "name": "Steel Bottle", "sku": "PRD-0001", "price": None, "cost": None, "description": "Hi", "shopify_handle": "steel-bottle", "seller_name": "SomeStore"}


def test_status_is_always_draft():
    product_input = build_product_input(product={**PRODUCT, "status": "ACTIVE", "vendor": "SomeStore"}, image_sources=[], file_video_sources=[], external_videos=[])
    assert product_input["status"] == "DRAFT"
    assert "vendor" not in product_input
    assert "SomeStore" not in json.dumps(product_input)
    assert product_input["variants"][0]["price"] == "0.00"


def test_handles():
    assert make_handle(PRODUCT) == "steel-bottle-prd-0001-12345678"
    assert make_handle({**PRODUCT, "name": "!!!"}) == "product-prd-0001-12345678"
    assert make_handle({**PRODUCT, "name": "Bouteille d'été"}) == "bouteille-d-ete-prd-0001-12345678"


# ---------- Shopify token (mock server) ----------

QUERY = "query FindDraftByHandle($identifier: ProductIdentifierInput!) { productByIdentifier(identifier: $identifier) { id } }"
VARS = {"identifier": {"handle": "x"}}


def test_token_grant_is_cached(shopify_env):
    from pla.shopify.client import graphql

    for _ in range(3):
        graphql(QUERY, VARS)
    calls = shopify_env.state()["oauthCalls"]
    assert len(calls) == 1
    assert calls[0] == {"grant_type": "client_credentials", "client_id": "mock-client", "client_secret": "mock-secret"}


def test_token_refreshed_before_expiry(shopify_env):
    from pla.shopify.client import graphql

    shopify_env.set({"tokenExpiresIn": 240})
    graphql(QUERY, VARS)
    graphql(QUERY, VARS)
    assert len(shopify_env.state()["oauthCalls"]) == 2


def test_wrong_credentials(shopify_env, monkeypatch):
    from pla.shopify.client import ShopifyError, graphql

    monkeypatch.setenv("SHOPIFY_CLIENT_SECRET", "wrong")
    with pytest.raises(ShopifyError, match="client secret"):
        graphql(QUERY, VARS)


def test_saved_details_win_and_secret_hidden(shopify_env):
    from pla import settings

    settings.save_shopify_credentials(method=None, domain="https://Page-Store.myshopify.com/admin", client_id="page-client", client_secret="page-secret")
    assert settings.shopify_credentials() == {"method": "client", "domain": "page-store.myshopify.com", "clientId": "page-client", "clientSecret": "page-secret", "adminToken": ""}
    summary = settings.shopify_summary()
    assert summary == {"method": "client", "domain": "page-store.myshopify.com", "clientId": "page-client", "hasSecret": True, "hasAdminToken": False, "source": "page"}
    assert "page-secret" not in json.dumps(summary)
    settings.save_shopify_credentials(method=None, domain="page-store", client_id="page-client-2", client_secret="")
    assert settings.shopify_credentials()["clientSecret"] == "page-secret"
    settings.clear_shopify_credentials()
    assert settings.shopify_credentials()["clientId"] == "mock-client"
    assert settings.shopify_summary()["source"] == "env"


def test_domains():
    from pla.settings import is_valid_domain, normalize_domain

    assert normalize_domain("  my-store ") == "my-store.myshopify.com"
    assert normalize_domain("https://My-Store.myshopify.com/admin/products") == "my-store.myshopify.com"
    assert is_valid_domain("my-store.myshopify.com")
    assert not is_valid_domain("not a domain")
    assert not is_valid_domain("")


def test_connection_test(shopify_env):
    from pla.shopify.client import test_shopify_connection

    assert test_shopify_connection() == {"shopName": "Mock Store", "domain": "mock-store.myshopify.com", "missingScopes": []}
    shopify_env.set({"scopes": ["write_products"]})
    assert test_shopify_connection()["missingScopes"] == ["write_inventory"]


def test_admin_token_sent_as_is(shopify_env):
    from pla import settings
    from pla.shopify.client import graphql, missing_shopify_settings, test_shopify_connection

    settings.save_shopify_credentials(method="token", domain="mock-store", admin_token="mock-token-admin")
    assert missing_shopify_settings() == []
    graphql(QUERY, VARS)
    graphql(QUERY, VARS)
    state = shopify_env.state()
    assert state["oauthCalls"] == []
    assert [c["token"] for c in state["graphql"]] == ["mock-token-admin", "mock-token-admin"]
    assert test_shopify_connection() == {"shopName": "Mock Store", "domain": "mock-store.myshopify.com", "missingScopes": []}
    summary = settings.shopify_summary()
    assert summary["method"] == "token" and summary["hasAdminToken"] and summary["source"] == "page"
    assert "mock-token-admin" not in json.dumps(summary)
    settings.save_shopify_credentials(method="token", domain="mock-store", admin_token="")
    assert settings.shopify_credentials()["adminToken"] == "mock-token-admin"


def test_wrong_admin_token(shopify_env):
    from pla import settings
    from pla.shopify.client import ShopifyError, graphql

    settings.save_shopify_credentials(method="token", domain="mock-store", admin_token="wrong-token")
    with pytest.raises(ShopifyError, match="Admin API access token"):
        graphql(QUERY, VARS)
    assert shopify_env.state()["graphql"] == []


def test_admin_token_in_env(shopify_env, monkeypatch):
    from pla import settings

    monkeypatch.setenv("SHOPIFY_ADMIN_TOKEN", "mock-token-env")
    assert settings.shopify_credentials()["method"] == "token"
    assert settings.shopify_summary()["source"] == "env"
    settings.save_shopify_credentials(method="client", domain="mock-store", client_id="mock-client", client_secret="mock-secret")
    assert settings.shopify_credentials()["method"] == "client"
    settings.clear_shopify_credentials()
    assert settings.shopify_credentials()["method"] == "token"


def test_missing_fields(shopify_env, monkeypatch):
    from pla import settings
    from pla.shopify.client import missing_shopify_settings

    for key in ("SHOPIFY_STORE_DOMAIN", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"):
        monkeypatch.setenv(key, "")
    assert missing_shopify_settings() == ["Store domain", "Client ID", "Client secret"]
    settings.save_shopify_credentials(method="token", domain="mock-store", admin_token="")
    assert missing_shopify_settings() == ["Admin API access token"]


def test_user_shopify_details_are_separate(shopify_env):
    """A signed-in user never falls back to the admin's .env store, and never sees the admin's saved details."""
    from pla import settings
    from pla.shopify.client import missing_shopify_settings

    settings.save_shopify_credentials(method="token", domain="admin-store", admin_token="mock-token-admin")
    settings.current_owner.set("user-1")
    try:
        assert missing_shopify_settings() == ["Store domain", "Client ID", "Client secret"]
        assert settings.shopify_summary()["source"] == "none"
        settings.save_shopify_credentials(method="token", domain="user-store", admin_token="mock-token-user")
        assert settings.shopify_credentials()["domain"] == "user-store.myshopify.com"
    finally:
        settings.current_owner.set(None)
    assert settings.shopify_credentials()["domain"] == "admin-store.myshopify.com"


# ---------- search cost and FastMoss ----------

def test_marketplaces():
    assert marketplace_of_hit({"original": "https://m.media-amazon.com/images/I/bottle.jpg", "pageUrl": "https://www.amazon.com/dp/B001"})["id"] == "amazon"
    assert marketplace_of_hit({"original": "https://example.com/a.jpg", "pageUrl": "", "source": "AliExpress"})["label"] == "AliExpress"
    assert marketplace_of_hit({"original": "https://cdn.example.com/a.jpg", "pageUrl": "https://shop.example.com/p/1", "source": "Good Store"}) is None
    amazon = [{"original": "a1"}, {"original": "a2"}, {"original": "a3"}]
    ali = [{"original": "e1"}, {"original": "a1"}]
    alibaba = [{"original": "b1"}]
    assert [h["original"] for h in take_marketplace_photos([amazon, ali, alibaba], 20)] == ["a1", "e1", "b1", "a2", "a3"]
    assert len(take_marketplace_photos([amazon, ali, alibaba], 2)) == 2


def test_request_price():
    cost = price_usage({"serpapi": 2, "fastmoss": 1, "aiInput": 1_000_000, "aiOutput": 500_000})
    assert cost["serpapiUsd"] == 0
    assert cost["aiUsd"] == pytest.approx(0.35)
    assert cost["totalUsd"] == pytest.approx(0.35)
    assert cost["fastmossCredits"] == 1
    assert money(cost["totalUsd"]) == "$0.3500"


def test_video_search_arguments():
    assert video_search_arguments(None, "steel bottle") == {"keywords": "steel bottle", "region": "US"}
    schema = {"properties": {"keyword": {"type": "string"}, "region": {"type": "string", "enum": ["US", "GB"]}}, "required": ["keyword"]}
    assert video_search_arguments(schema, "bottle") == {"keyword": "bottle", "region": "US"}


def test_video_results():
    hits = videos_from_payload({
        "list": [
            {"title": "Bottle demo", "unique_id": "shop", "video_id": "123", "cover": "https://cdn.example.com/a.jpg", "fastmoss_url": "https://www.fastmoss.com/video/123"},
            {"url": "https://shop.example.com/about"},
        ]
    })
    assert hits == [{"url": "https://www.tiktok.com/@shop/video/123", "title": "Bottle demo", "creator": "shop", "pageUrl": "https://www.fastmoss.com/video/123"}]


# ---------- theme templates (mock server) ----------

SCOPES = ["write_products", "write_inventory", "write_themes"]


def _template():
    from pla.templates import find_template, read_template_files

    return find_template("saamano"), read_template_files("saamano")


def test_saamano_is_three_new_files():
    _, files = _template()
    assert [f["filename"] for f in files] == [
        "assets/fynk-autolisting-product.css",
        "sections/fynk-autolisting-product.liquid",
        "templates/product.fynk-autolisting-product.json",
    ]
    assert all(f["type"] == "TEXT" for f in files)
    assert json.loads(files[2]["value"])["sections"]["main"]["type"] == "fynk-autolisting-product"
    assert "'fynk-autolisting-product.css' | asset_url | stylesheet_tag" in files[1]["value"]


@pytest.mark.parametrize("template_id, sections", [
    ("classic", ["fynk-classic-faq", "fynk-classic-features", "fynk-classic-hero", "fynk-classic-special", "fynk-classic-stats", "fynk-classic-steps"]),
])
def test_page_templates_are_only_new_files_and_never_touch_the_theme_or_another_app(template_id, sections):
    import re

    from pla.shopify.theme import OWN_FILE
    from pla.templates import find_template, read_template_files

    template = find_template(template_id)
    files = read_template_files(template_id)
    suffix = template["templateSuffix"]
    names = [f["filename"] for f in files]
    assert names == [f"sections/{name}.liquid" for name in sections] + [f"templates/product.{suffix}.json"]
    assert all(OWN_FILE.search(name) for name in names)
    by_name = {f["filename"]: f["value"] for f in files}
    page = json.loads(by_name[f"templates/product.{suffix}.json"])
    assert sorted(page["order"]) == sections and set(page["sections"]) == set(sections)
    for key, section in page["sections"].items():
        source = by_name[f"sections/{section['type']}.liquid"]
        schema = json.loads(re.search(r"\{% schema %\}(.*?)\{% endschema %\}", source, re.S).group(1))
        known = {s.get("id") for s in schema["settings"]}
        assert set(section.get("settings", {})) <= known, key
        block_types = {b["type"]: {s.get("id") for s in b.get("settings", [])} for b in schema.get("blocks", [])}
        for block in section.get("blocks", {}).values():
            assert set(block["settings"]) <= block_types[block["type"]], key
        assert section.get("block_order", []) == list(section.get("blocks", {}))
        # Nothing that needs the Roarr app or a theme colour scheme.
        assert "roarr" not in source.lower()
        assert "color_scheme" not in source
        assert "block_control" not in source
        assert "product-form-component" not in source
    assert "saamano.faq" in by_name[f"sections/fynk-{template_id}-faq.liquid"]


def test_upload_batches():
    from pla.shopify.theme import upload_batches

    def fake(name, size=10):
        return {"filename": name, "type": "TEXT", "value": "x" * size, "md5": "", "bytes": size}

    assert [len(b) for b in upload_batches([fake(f"assets/a{i}.js") for i in range(120)])] == [50, 50, 20]
    assert [len(b) for b in upload_batches([fake("assets/big.js", 700_000), fake("assets/big2.js", 700_000)])] == [1, 1]
    mixed = upload_batches([fake("templates/product.json"), fake("sections/main.liquid"), fake("snippets/a.liquid")])
    assert [[f["filename"] for f in b] for b in mixed] == [["snippets/a.liquid"], ["sections/main.liquid"], ["templates/product.json"]]


def test_push_only_adds_files(shopify_env):
    from pla.settings import last_template_push
    from pla.shopify.theme import push_theme_template

    template, files = _template()
    shopify_env.set({"scopes": SCOPES})
    before = shopify_env.state()["themes"][0]
    steps: list[str] = []
    result = push_theme_template(template, steps.append)
    state = shopify_env.state()
    assert len(state["themes"]) == 1
    live = state["themes"][0]
    assert live["role"] == "MAIN"
    for name, checksum in before["files"].items():
        assert live["files"][name] == checksum, name
    for file in files:
        assert live["files"][file["filename"]] == file["md5"], file["filename"]
    assert len(live["files"]) == len(before["files"]) + len(files)
    names = [c["name"] for c in state["graphql"]]
    assert "DuplicateTheme" not in names and "DeleteThemeFiles" not in names
    assert all("fynk-" in f for upload in state["themeUploads"] for f in upload["files"])
    assert result["domain"] == "mock-store.myshopify.com"
    assert result["themeId"] == live["id"]
    assert result["themeName"] == "Dawn"
    assert result["productPreviewUrl"] == "https://mock-store.myshopify.com/products/steel-bottle?view=fynk-autolisting-product"
    assert result["editorUrl"] == "https://mock-store.myshopify.com/admin/themes/1/editor"
    assert result["uploaded"] == 3 and result["warnings"] == []
    assert "Nothing already in it changes" in " ".join(steps)
    saved = last_template_push("saamano")
    assert saved["themeId"] == live["id"] and saved["domain"] == "mock-store.myshopify.com"


def test_push_again_replaces_only_own_files(shopify_env):
    from pla.shopify.theme import push_theme_template

    template, _ = _template()
    shopify_env.set({"scopes": SCOPES})
    push_theme_template(template)
    once = shopify_env.state()["themes"][0]["files"]
    push_theme_template(template)
    assert shopify_env.state()["themes"][0]["files"] == once


def test_without_write_themes_nothing_changes(shopify_env):
    from pla.shopify.client import ShopifyError
    from pla.shopify.theme import push_theme_template

    template, _ = _template()
    before = shopify_env.state()["themes"]
    with pytest.raises(ShopifyError, match="write_themes"):
        push_theme_template(template)
    state = shopify_env.state()
    assert state["themes"] == before
    assert "UpsertThemeFiles" not in [c["name"] for c in state["graphql"]]


def test_no_theme_permission_message(shopify_env):
    from pla.shopify.client import ShopifyError
    from pla.shopify.theme import push_theme_template

    template, _ = _template()
    shopify_env.set({"scopes": ["write_products", "write_inventory"]})
    with pytest.raises(ShopifyError) as caught:
        push_theme_template(template)
    message = str(caught.value)
    assert "missing the write_themes and read_themes permissions" in message
    assert "Nothing in your store was changed" in message
    assert "Access denied" not in message
    assert [c["name"] for c in shopify_env.state()["graphql"]] == ["ThemeScopes"]


def test_write_themes_alone_is_enough(shopify_env):
    from pla.shopify.theme import push_theme_template

    template, _ = _template()
    shopify_env.set({"scopes": ["write_products", "write_themes"]})
    assert push_theme_template(template)["uploaded"] == 3


def test_read_themes_alone_is_not_enough(shopify_env):
    from pla.shopify.client import ShopifyError
    from pla.shopify.theme import push_theme_template

    template, _ = _template()
    shopify_env.set({"scopes": ["write_products", "read_themes"]})
    with pytest.raises(ShopifyError, match="missing the write_themes permission, so"):
        push_theme_template(template)


def test_refused_file_is_tried_again(shopify_env):
    from pla.shopify.theme import push_theme_template

    template, files = _template()
    shopify_env.set({"scopes": SCOPES, "themeFailOnce": ["templates/product.fynk-autolisting-product.json"]})
    assert push_theme_template(template)["warnings"] == []
    assert shopify_env.state()["themes"][0]["files"]["templates/product.fynk-autolisting-product.json"] == files[2]["md5"]


def test_admin_token_push(shopify_env):
    from pla import settings
    from pla.shopify.theme import push_theme_template

    template, _ = _template()
    settings.save_shopify_credentials(method="token", domain="mock-store", admin_token="mock-token-admin")
    shopify_env.set({"scopes": SCOPES})
    push_theme_template(template)
    state = shopify_env.state()
    assert state["oauthCalls"] == []
    assert all(c["token"] == "mock-token-admin" for c in state["graphql"])


# ---------- Saamano metafields ----------

def test_metafields():
    story = {
        "source": "x",
        "featureHeading": "Tough | Practical",
        "featureSubheading": "",
        "featureCards": [{"title": "No Leaks", "text": "Keeps your\nbag dry."}],
        "topFeaturesSubheading": "Fresh | secure",
        "topFeatures": [{"title": "Sealed Locking", "text": "Leak-proof for\nall diets."}, {"title": "Eco-Friendly", "text": "BPA-free."}],
        "compareIntro": "Line one.\nLine two.",
        "compareRows": ["Fits in a bag"],
        "faq": [{"question": "Cash on delivery?", "answer": "Yes."}],
    }
    fields = saamano_metafields({"description": "A bottle.\n- Steel body: Strong and light\n- Fits cup holders"}, story)
    by_key = {f["key"]: f for f in fields}
    assert sorted(by_key) == ["compare", "compare_intro", "faq", "feature_heading", "features", "highlights", "top_features", "top_features_subheading"]
    assert json.loads(by_key["top_features"]["value"]) == ["Sealed Locking|Leak-proof for all diets.", "Eco-Friendly|BPA-free."]
    assert by_key["top_features"]["type"] == "list.single_line_text_field"
    assert by_key["top_features_subheading"]["value"] == "Fresh / secure"
    assert by_key["feature_heading"]["value"] == "Tough / Practical"
    assert json.loads(by_key["features"]["value"]) == ["No Leaks|Keeps your bag dry."]
    assert by_key["compare_intro"]["type"] == "multi_line_text_field" and by_key["compare_intro"]["value"] == "Line one.\nLine two."
    assert json.loads(by_key["highlights"]["value"]) == ["Steel body|Strong and light", "Fits cup holders"]
    assert all(f["namespace"] == "saamano" and f["value"] for f in fields)


def test_metafields_without_story():
    assert saamano_metafields({"description": "Plain text, no list."}, None) == []
    assert [f["key"] for f in saamano_metafields({"description": "- One"}, None)] == ["highlights"]


# ---------- Fly keep-awake ----------

def test_has_running_work_follows_jobs_and_sends():
    """The Fly machine is kept on only while research or a Shopify send is in progress."""
    import uuid

    from pla import db, repo

    for table in ("jobs", "products"):
        db.execute(f"DELETE FROM {table}")
    assert repo.has_running_work() is False

    product_id = str(uuid.uuid4())
    created = repo.create_product_with_job(id=product_id, name="Keep awake bottle")
    assert repo.has_running_work() is True  # queued research

    repo.finish_job(created["job"]["id"], "DONE", "Ready for review", None)
    assert repo.has_running_work() is False

    repo.update_product(product_id, {"shopify_status": "sending"})
    assert repo.has_running_work() is True  # a Shopify send
    repo.update_product(product_id, {"shopify_status": "draft"})
    assert repo.has_running_work() is False
