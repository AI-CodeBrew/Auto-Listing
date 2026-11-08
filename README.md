# Product Listing Assistant

A local web app for one user. Give it a product image, video, or name. It finds the product's details on the web, you review and approve them, and it creates a **draft** product in Shopify. It never publishes anything.

## Run it

You need Node.js 20.9 or newer. These steps were tested on Windows 10 with Node 24.

1. Get an AI key: an OpenAI key at https://platform.openai.com/api-keys (GPT), or a Claude key at https://console.anthropic.com. You only need one.
2. Set up the app:
   ```
   npm install
   npm run setup
   copy .env.example .env
   ```
3. Open `.env`. For GPT, put your key after `OPENAI_API_KEY=` and set `AI_PROVIDER=openai`. For Claude, put it after `AI_API_KEY=` and set `AI_PROVIDER=claude`.
4. Start it:
   ```
   npm run build
   npm start
   ```
5. Open the **Shopify** tab and connect your store (see below). You can skip this at first: research and review work without it.

Open http://localhost:3000. The app only listens on your own computer.

## Settings

The AI key goes in `.env`. Restart the app after changing `.env`.

| Setting | What it is |
|---|---|
| `AI_PROVIDER` | `openai` or `claude`. |
| `OPENAI_API_KEY` | Your OpenAI key. Used when the provider is `openai`. |
| `OPENAI_MODEL` | The GPT model. It must read images. The default is `gpt-4o-mini`. |
| `AI_API_KEY` | Your Claude API key. Used when the provider is `claude`. |
| `AI_MODEL` | The Claude model. The default is `claude-sonnet-5-5`. |
| `PUBLIC_BASE_URL` | Optional. The public tunnel address, so Google Lens can fetch your uploaded photo. |
| `SERPAPI_KEY` | Optional but recommended. Your [SerpAPI](https://serpapi.com) key. With it, pictures come from Google Images (see How search works). |
| `SHOPIFY_API_VERSION` | The default is `2026-10`. |

## Connecting Shopify

Open the **Shopify** tab, fill in the three fields and press **Save**, then **Test connection**. The test shows your shop's name and tells you if the app is missing a permission. No restart is needed.

- **Store domain**: for example `my-store.myshopify.com`. Just `my-store` also works.
- **Client ID** and **Client secret**: from your app in the Shopify Dev Dashboard.

To get them:

1. Create an app in the [Dev Dashboard](https://dev.shopify.com/dashboard).
2. Give its version the `write_products` and `write_inventory` scopes, then release it.
3. Install the app on your store. The app and the store must be in the same organization.
4. Open the app's Settings and copy the Client ID and Secret.

The details are saved in `./data` on your computer. The secret is never shown again or sent back to the browser. Leave the secret empty when you save to keep the one already saved. **Remove** forgets everything saved on the page.

Old setups still work: if you filled `SHOPIFY_STORE_DOMAIN`, `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET` in `.env`, they are used until you save details on the Shopify tab. The tab's details win.

## How search works

**With `SERPAPI_KEY` set (recommended)**, the app does not search or open dozens of web pages. Instead:

1. The AI looks at your photo (or uses your product name) to decide what to search for.
2. SerpAPI returns large pictures from **Google Images**, with their sizes and the pages they are on. Social media and blog pages are skipped.
3. The AI checks each picture (clear, right product, no watermark or other store's logo), stopping once 8 have passed.
4. The pages of the best pictures (up to 5) are opened only to read their text. The AI uses that text, plus the picture titles from Google, to write the name and description.

If you upload a photo and set `PUBLIC_BASE_URL` (see Google Lens below), step 2 starts with **Google Lens**, which finds pictures that look like your photo. A normal Google Images search fills the gap if Lens finds too few.

A product uses 1 or 2 SerpAPI searches. The AI is used to check pictures and to write the text, not to compare pages. Pages that block automated access (Amazon often does) are skipped, and the text then relies on the picture titles. Pages you paste are still compared and used.

**Without `SERPAPI_KEY`**, the app falls back to the Bing method described below.

### Google Lens (optional, for photo uploads)

Lens cannot take a file. It needs a public web address for your photo, and this app only runs on your computer. A free tunnel gives it a public address:

1. Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) (or use ngrok).
2. Start the app, then in a second terminal run:
   ```
   cloudflared tunnel --url http://localhost:3001
   ```
3. Copy the `https://....trycloudflare.com` address it prints into `.env`:
   ```
   PUBLIC_BASE_URL=https://something.trycloudflare.com
   ```
4. Restart the app. The address changes every time you restart the tunnel, so update `.env` each time.

What the tunnel exposes: **only** a signed link to the one photo being searched. Every other page and API answers 404 to requests that arrive through the tunnel, and the link cannot be guessed. Do not use options that rewrite the Host header, and keep the tunnel closed when you are not researching.

If `PUBLIC_BASE_URL` is empty or the tunnel is down, the app notes that in the Review warnings and uses a normal Google Images search instead, without wasting a SerpAPI search.

**Bing's `robots.txt` currently forbids automated access to `/search`, and this app respects `robots.txt`.** So on the real Bing, no search is run:

- If you gave product page URLs, research continues with those and shows a warning.
- If you did not, the job goes to BLOCKED and asks you to paste URLs.

Everything after the search works normally. To use a different search source, write a new provider in `src/lib/search/` and return it from `getSearchProvider()` in `src/lib/search/index.ts`. Nothing else needs to change.

## Good to know

- **Jobs run one at a time.** They are stored in SQLite. If the app stops mid-job, the job restarts from the beginning when the app next starts, up to 3 attempts.
- **Blocked sites are skipped.** If a site shows a CAPTCHA or bot block, the app leaves out that page and the site's other pages, tells you in the Review tab, and carries on with the rest. It does not try to get around blocks. Large marketplaces such as eBay, Walmart and Alibaba often block it, so smaller stores and brand websites tend to work better.
- **BLOCKED** means blocks left no usable page at all. Paste other product page URLs to continue.
- **Retries are quicker.** The AI's analysis of your uploaded image or video is kept, so Search Again, pasted URLs and restarts do not repeat it.
- **"Needs checking" marks** stay in the description until you remove them, including in the Shopify draft, so an unconfirmed claim can't slip through unnoticed. The Listing tab warns you while any remain.
- **After a product is a Shopify draft,** it is locked here. Make further edits in Shopify.
- **Shopify handles** include the SKU and a short ID, like `steel-bottle-prd-0001-1a2b3c4d`. That is what lets Retry find a product whose creation response was lost, so it never makes a duplicate. You can change the handle in Shopify before publishing.
- **TikTok, Instagram and Facebook videos** are saved as links for your reference, but Shopify can only attach YouTube and Vimeo links, so the others are left out of the draft.
- **Limits per product:** at most 5 videos are downloaded. Vision checks at most 30 images and stops once 15 have passed. These are in `src/lib/config.ts`.
- **Your data** is in `./data` (the database) and `./storage/<productId>/` (images and videos).

## Tests

```
npm test
```

This builds a separate copy of the app and runs it against a mock server that stands in for shopping sites, Bing, the Claude API and Shopify. It needs no credentials, costs nothing, and does not touch your `data` or `storage` folders. Test data goes in `.test-data`.

Port 3100, 3101, 4100 and 4101 must be free while tests run.

## Where things are

| Path | Purpose |
|---|---|
| `src/app/` | The three tabs and the API routes |
| `src/lib/ai.ts` | All AI calls (OpenAI and Claude API) |
| `src/lib/settings.ts` | Shopify details saved from the Shopify tab |
| `src/lib/search/` | Search, replaceable |
| `src/lib/storage.ts` | File storage, replaceable |
| `src/lib/pipeline/research.ts` | The research steps |
| `src/lib/queue.ts` | The background job queue |
| `src/lib/web/` | Playwright, page extraction, `robots.txt`, and network safety |
| `src/lib/media/` | Image and video handling |
| `src/lib/shopify/` | Shopify token, uploads and draft creation |
| `tests/` | Automated tests and the mock server |
