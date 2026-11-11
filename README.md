# Product Listing Assistant

A web app for your users and you (the admin). Give it a product image, video, or name. It finds the product's details on the web, you review and approve them, and it creates a **draft** product in Shopify. It never publishes anything.

## How it is built

The app has two parts:

- **`frontend/`**: the screens (Next.js). It has no keys and no database. Every `/api/...` call is passed to the backend.
- **`backend/`**: everything else (Python, FastAPI): accounts, billing, the admin portal, research, AI, images, videos and Shopify. Its records live in Supabase (`DATABASE_URL`) and product photos and videos in Bunny Storage (`BUNNY_*`). With those empty it falls back to a local SQLite file in `backend/data` and files in `backend/storage`.

Your keys stay in `backend/.env`. Only the backend reads it. The frontend has its own `frontend/.env` with one line, `BACKEND_URL`.

## Run it

You need Node.js 20.9 or newer and Python 3.11 or newer. These steps were tested on Windows 10.

1. Copy the settings file and fill it in (AI key, and the admin login, see below):
   ```
   copy backend\.env.example backend\.env
   copy frontend\.env.example frontend\.env
   ```
2. Set up the backend (once):
   ```
   cd backend
   python -m venv .venv
   .venv\Scripts\python -m pip install -r requirements.txt
   .venv\Scripts\python -m playwright install chromium
   ```
3. Set up the frontend (once):
   ```
   cd frontend
   npm install
   ```
4. Start both, each in its own terminal:
   ```
   cd backend
   .venv\Scripts\python -m uvicorn app:app --host 127.0.0.1 --port 8000
   ```
   ```
   cd frontend
   npm run build
   npm start
   ```
   For development use `npm run dev` instead of `npm run build` and `npm start`. From the `frontend` folder, `npm run backend` also starts the backend.

Open http://localhost:3000. The app only listens on your own computer. If the backend runs somewhere else, set `BACKEND_URL` in `frontend/.env` (default `http://127.0.0.1:8000`).

## Supabase and Bunny

- **Supabase** is the database when `DATABASE_URL` is set: every backend (this computer, Fly.io) reads and writes the same records, and the tables are created on start from `backend/schema.sql`.
- **Bunny** keeps the photos and videos: research and uploads move finished files there, pages show them from the CDN, and Shopify fetches photos straight from it.
- Check both with the keys in `backend/.env`: `cd backend`, then `.venv\Scripts\python check_cloud.py`. It writes one test file to Bunny and deletes it again.
- Move what was kept on this computer (records in `backend/data`, files in `backend/storage`) once, with the local backend stopped: `.venv\Scripts\python move_to_cloud.py`. It is safe to run again and deletes nothing locally.

## Deploy the backend to Fly.io

`backend/Dockerfile` and `backend/fly.toml` are ready. The build runs from the project folder (it also needs `frontend/theme-templates`); `.dockerignore` sends only the backend code, `schema.sql` and the theme files, never `.env`, `data` or `storage`. No volume: the records are in Supabase and the files in Bunny. The region is Tokyo (`nrt`), the closest to the Supabase database. The machine stops when nobody uses it and starts again on the next request; while research or a Shopify send runs, the backend keeps it on by itself. Chromium starts only when a product page must be read (pasted URLs, or name-only searches); Google Lens photo searches do not use it.

```
fly auth login
cd D:\Auto-listing
fly apps create autolisting-backend
cd backend
.venv\Scripts\python -c "import subprocess; from pla.envfile import _parse; d = '\n'.join(f'{k}={v}' for k, v in _parse('.env').items() if v and not k.startswith('SUPABASE_')); subprocess.run(['fly', 'secrets', 'import', '-a', 'autolisting-backend'], input=d.encode(), check=True)"
cd ..
fly deploy . --config backend/fly.toml --dockerfile backend/Dockerfile --ha=false
```

Then set `BACKEND_URL=https://autolisting-backend.fly.dev` in `frontend/.env`. Run the same `fly deploy` line after every backend change. (Python hands the keys to `fly` itself: a PowerShell pipe would add an invisible mark before the first key name, which Fly refuses.) A backend on this computer with the same `DATABASE_URL` shares the records with Fly; a job is only ever run by one of them.

## Accounts, searches and billing

- **Users** sign up at `/signup` and log in at `/login`. A new account gets **2 free searches**. One search is one product sent for research (Add new listing). A refused upload does not use a search.
- Each user has their own listings and connects their own Shopify store on Integrations. Users never see SerpAPI or the AI cost; their **Usage** page shows only how many searches they have left.
- **Billing** shows three plans. A user picks one, writes how they paid (for example a JazzCash transaction ID) and sends the request.
- **Admin** logs in at `/admin/login` with `ADMIN_EMAIL` and `ADMIN_PASSWORD` from `backend/.env`. There is no admin sign-up. The admin portal (`/admin`) shows:
  - **Overview**: users, waiting requests, searches used and left, SerpAPI keys, AI cost.
  - **Users**: add or take away searches, block or unblock an account.
  - **Billing requests**: approve (and choose how many searches to give) or reject.
  - **Plans**: change the three plans' names, prices and searches.
  - **SerpAPI**: both keys, searches used and left, and the automatic switch.
- The admin has no search limit. Listings made before accounts existed belong to the admin.

## Settings

The AI key goes in `backend/.env`. Restart the backend after changing it.

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

Open **Integrations** → **Shopify**, choose how you connect, fill in the fields and press **Save**, then **Test connection**. The test shows your shop's name and tells you if the app is missing a permission. No restart is needed.

- **Store domain**: for example `my-store.myshopify.com`. Just `my-store` also works.
- Then one of these two:
  - **Client ID + secret**: from your app in the Shopify Dev Dashboard. Use this for a new app.
  - **Admin token**: the Admin API access token (`shpat_...`) of an app made in the Shopify admin under **Develop apps**. Shopify no longer lets you make new apps there, but existing ones keep working.

To get the client ID and secret:

1. Create an app in the [Dev Dashboard](https://dev.shopify.com/dashboard).
2. Give its version the `write_products` and `write_inventory` scopes, then release it.
3. Install the app on your store. The app and the store must be in the same organization.
4. Open the app's Settings and copy the Client ID and Secret.

To get the Admin token: in the Shopify admin open **Apps** → **Develop apps** → your app. Check that its Admin API scopes include `write_products` and `write_inventory`, then copy the token from **API credentials**.

The details are saved in the database (Supabase, or `backend/data` without it). The secret and the token are never shown again or sent back to the browser. Leave them empty when you save to keep the ones already saved. Each option keeps its own details, so you can switch back without typing them again. **Remove** forgets everything saved on the page.

Old setups still work: if you filled `SHOPIFY_STORE_DOMAIN` with `SHOPIFY_CLIENT_ID` and `SHOPIFY_CLIENT_SECRET`, or with `SHOPIFY_ADMIN_TOKEN`, in `backend/.env`, they are used until you save details on the Shopify tab. The tab's details win.

## Template (add the product page to a store)

The **Template** page has product page designs. Right now that is the **Saamano product page**. Its files are in `frontend/theme-templates/fynk-autolisting-product/`.

**Push to Shopify** adds the page to the connected store's **current (live) theme**, whatever theme that is. It only adds three new files, all named with `fynk-`:

- `sections/fynk-autolisting-product.liquid`: the whole page in one section. It uses none of the theme's own snippets, so it works in any theme.
- `assets/fynk-autolisting-product.css`: its styles, all under `.sp`. The app's Preview uses this same file.
- `templates/product.fynk-autolisting-product.json`: an alternate product template that shows the section.

Nothing already in the theme is changed or deleted. The home page, header, footer, contact page and every other product look exactly as before. Only products you push from **Approved listings** use the new page: the push sets their template to `fynk-autolisting-product`. Pushing the template again replaces only those three files.

When it finishes, the page links to the theme editor and to a preview: any active product shown with the new page through `?view=fynk-autolisting-product`.

The app needs the `write_themes` permission for this (add `read_themes` and `write_themes` to the app's scopes). Without it, the page tells you what to add and changes nothing.

The lines that are the same for every product (delivery, bundle discount, trust badges, headings) are the section's settings. Change them in **Online Store → Themes → Customize**, on a product that uses the page. The bundle percentages must match automatic discounts set up in Shopify, or customers will not get them at checkout.

### Each product's own page text

The Saamano product page shows text written for that product: feature cards, "Why Choose Us?" and the FAQ. Your AI model (OpenAI or Claude) writes it from the product's name and description **when you approve the product**, in one request. It is saved and reused, and written again only if the name or description changes. **Preview** on Approved listings shows the page with this text and the approved photos.

When you push a listing, the photos go to Shopify as usual and the text goes with it as product metafields in the `saamano` namespace. The theme reads them, so each product page shows its own text:

| Metafield | Type | Shown in |
|---|---|---|
| `saamano.feature_heading`, `saamano.feature_subheading` | single line text | Heading above the feature cards |
| `saamano.features` | list of single line text, `title\|text` | Feature cards, each with one of the product's photos |
| `saamano.top_features_subheading` | single line text | Line under "Top Features" (after About this product) |
| `saamano.top_features` | list of single line text, `title\|text` | "Top Features": 4 cards, two each side of the product's third photo |
| `saamano.highlights` | list of single line text, `title\|text` | "Why you'll love it", from the description's `- ` lines |
| `saamano.compare_intro` | multi-line text | Text beside the comparison table |
| `saamano.compare` | list of single line text | Rows of "Why Choose Us?" |
| `saamano.faq` | list of single line text, `question\|answer` | "Good to know" |

If the AI cannot write the text when you push (for example, the key is missing), the product is still pushed with a warning, without that text. A section with no text is hidden on the store.

To change the page, edit the files in `frontend/theme-templates/fynk-autolisting-product/`. Keep every file name starting with `fynk-` (the push refuses any other name, so it can never replace a store's own file), and check the Liquid with Shopify Theme Check before pushing.

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
3. Copy the `https://....trycloudflare.com` address it prints into `backend/.env`:
   ```
   PUBLIC_BASE_URL=https://something.trycloudflare.com
   ```
4. Restart the app. The address changes every time you restart the tunnel, so update `backend/.env` each time.

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
- **Limits per product:** at most 5 videos are downloaded. Vision checks at most 30 images and stops once 15 have passed. These are in `backend/pla/config.py`.
- **Your data** is in Supabase and Bunny (`<productId>/images` and `<productId>/videos`); without them, in `backend/data` (the database) and `backend/storage/<productId>/`.

## Tests

```
cd frontend
npm test
```

This builds a separate copy of the app, starts it with its own backend, and runs it against a mock server that stands in for shopping sites, Bing, the Claude API, OpenAI, SerpAPI and Shopify. It also runs the backend's own tests (`backend/tests`, pytest). It needs no credentials, costs nothing, and does not touch your `backend/data` or `backend/storage` folders. Test data goes in `frontend/.test-data`.

Ports 3100, 3101, 4100, 4101, 5100 and 5101 must be free while tests run.

## Where things are

| Path | Purpose |
|---|---|
| `frontend/src/app/` | The screens: listings, Billing, Usage, login and sign-up, and the admin portal (`admin/`) |
| `frontend/src/app/api/[...path]/route.ts` | Passes every `/api` call to the backend |
| `frontend/src/proxy.ts` | Sends signed-out visitors to the login page |
| `backend/app.py` | The FastAPI app |
| `backend/pla/api.py` | Every API route |
| `backend/pla/accounts.py` | Sign-up, login, searches, plans and billing requests |
| `backend/pla/ai.py` | All AI calls (OpenAI and Claude API) |
| `backend/pla/settings.py` | Shopify details saved from the Integrations page, per account |
| `backend/pla/search/` | Google Images and Lens (SerpAPI), Bing, FastMoss |
| `backend/pla/pipeline/research.py` | The research steps |
| `backend/pla/queue.py` | The background job queue |
| `backend/pla/web/` | Playwright, page extraction, `robots.txt`, and network safety |
| `backend/pla/media/` | Image and video handling |
| `backend/pla/shopify/` | Shopify token, uploads, draft creation and theme push |
| `backend/tests/` | Backend unit tests (pytest) |
| `frontend/theme-templates/` | The product page files added to a store's theme, byte for byte |
| `frontend/tests/` | Automated tests and the mock server |
