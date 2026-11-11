import { expect, request as newRequest, test, type APIRequestContext } from "@playwright/test";
import { APP_URL, mockReset, waitForStage } from "./helpers";

/** A client with no session, for a user who signs up. */
async function stranger(): Promise<APIRequestContext> {
  return newRequest.newContext({ baseURL: APP_URL, storageState: { cookies: [], origins: [] } });
}

const uniqueEmail = (label: string) => `${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

test.beforeEach(async () => {
  await mockReset();
});

test.describe("accounts and searches", () => {
  test("the API needs a login, and only the admin may open the admin API", async () => {
    const guest = await stranger();
    try {
      expect((await guest.get("/api/products")).status()).toBe(401);
      expect((await guest.get("/api/settings/serpapi")).status()).toBe(401);
      const signup = await guest.post("/api/auth/signup", { data: { name: "Guest", email: uniqueEmail("guest"), password: "password123" } });
      expect(signup.status(), await signup.text()).toBe(201);
      expect((await guest.get("/api/admin/users")).status()).toBe(403);
      expect((await guest.get("/api/settings/serpapi")).status()).toBe(403);
      const status = await (await guest.get("/api/status")).json();
      expect(status.serpPlan).toBeNull();
      expect(status.account.searchesLeft).toBe(2);
    } finally {
      await guest.dispose();
    }
  });

  test("a new user gets 2 free searches; the admin approves a plan and the user can search again", async ({ request }) => {
    const user = await stranger();
    const email = uniqueEmail("buyer");
    try {
      const signup = await user.post("/api/auth/signup", { data: { name: "Buyer", email, password: "password123" } });
      expect(signup.status(), await signup.text()).toBe(201);

      const first = await user.post("/api/products", { multipart: { name: "Steel Bottle", urls: "" } });
      expect(first.status(), await first.text()).toBe(201);
      const second = await user.post("/api/products", { multipart: { name: "Steel Bottle two", urls: "" } });
      expect(second.status(), await second.text()).toBe(201);
      const third = await user.post("/api/products", { multipart: { name: "Steel Bottle three", urls: "" } });
      expect(third.status()).toBe(402);
      expect(await third.text()).toContain("no searches left");

      // The user's product reaches review (the earlier one moves to History), and the admin's own
      // workspace does not show either of them.
      const firstId = (await first.json()).product.id;
      await waitForStage(user, (await second.json()).product.id, "review");
      const adminList = await (await request.get("/api/products?stages=review,history")).json();
      expect(adminList.products.map((p: { id: string }) => p.id)).not.toContain(firstId);
      expect((await request.get(`/api/products/${firstId}`)).status()).toBe(404);

      const billing = await (await user.get("/api/billing")).json();
      expect(billing.plans.map((p: { id: string }) => p.id)).toEqual(["starter", "pro", "business"]);
      const asked = await user.post("/api/billing/request", { data: { planId: "starter", paymentNote: "JazzCash 4455" } });
      expect(asked.status(), await asked.text()).toBe(201);

      const pending = await (await request.get("/api/admin/billing?status=pending")).json();
      const mine = pending.requests.find((item: { userEmail: string }) => item.userEmail === email);
      expect(mine.paymentNote).toBe("JazzCash 4455");
      const approved = await request.post(`/api/admin/billing/${mine.id}`, { data: { approve: true, searches: 3, note: "Thanks" } });
      expect(approved.status(), await approved.text()).toBe(200);

      const account = await (await user.get("/api/account")).json();
      expect(account.user.searchesLeft).toBe(3);
      const again = await user.post("/api/products", { multipart: { name: "Steel Bottle four", urls: "" } });
      expect(again.status(), await again.text()).toBe(201);
      expect((await (await user.get("/api/account")).json()).user.searchesLeft).toBe(2);
    } finally {
      await user.dispose();
    }
  });

  test("a refused upload does not use a search", async () => {
    const user = await stranger();
    try {
      await user.post("/api/auth/signup", { data: { name: "Careful", email: uniqueEmail("careful"), password: "password123" } });
      const bad = await user.post("/api/products", { multipart: { name: "x", urls: "javascript:alert(1)" } });
      expect(bad.status()).toBe(400);
      expect((await (await user.get("/api/account")).json()).user.searchesLeft).toBe(2);
    } finally {
      await user.dispose();
    }
  });

  test("the admin can give searches and block a user", async ({ request }) => {
    const user = await stranger();
    const email = uniqueEmail("blocked");
    try {
      await user.post("/api/auth/signup", { data: { name: "Blocked", email, password: "password123" } });
      const users = await (await request.get("/api/admin/users")).json();
      const row = users.users.find((item: { email: string }) => item.email === email);
      const more = await request.patch(`/api/admin/users/${row.id}`, { data: { addSearches: 10 } });
      expect((await more.json()).user.searchesLeft).toBe(12);
      await request.patch(`/api/admin/users/${row.id}`, { data: { status: "blocked" } });
      expect((await user.get("/api/products")).status()).toBe(401);
      const login = await user.post("/api/auth/login", { data: { email, password: "password123" } });
      expect(login.status()).toBe(403);
    } finally {
      await user.dispose();
    }
  });
});

test.describe("account screens", () => {
  test("sign up, see 2 searches, and ask for a plan on the Billing page", async ({ browser }) => {
    const context = await browser.newContext({ baseURL: APP_URL, storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    try {
      await page.goto("/usage");
      await expect(page).toHaveURL(/\/login/);
      await page.getByRole("link", { name: "Create an account" }).click();
      await page.getByLabel("Name").fill("Screen User");
      await page.getByLabel("Email").fill(uniqueEmail("screen"));
      await page.getByLabel("Password").fill("password123");
      await page.getByRole("button", { name: "Sign up" }).click();
      await expect(page.getByTestId("searches-left")).toContainText("2");

      await page.goto("/usage");
      await expect(page.getByTestId("usage-left")).toHaveText("2");
      // A user never sees the SerpAPI keys.
      await expect(page.getByTestId("serp-keys")).toHaveCount(0);

      await page.goto("/billing");
      await page.getByTestId("plan-pro").getByRole("button", { name: "Choose" }).click();
      await page.getByPlaceholder(/JazzCash/).fill("Bank transfer 7788");
      await page.getByRole("button", { name: "Send request to admin" }).click();
      await expect(page.getByText("Waiting for the admin.")).toBeVisible();

      // The admin portal is closed to a user.
      await page.goto("/admin");
      await expect(page).toHaveURL(/\/admin\/login/);
    } finally {
      await context.close();
    }
  });

  test("the admin portal shows users, requests, plans and SerpAPI", async ({ page }) => {
    await page.goto("/admin");
    await expect(page.getByRole("heading", { name: "Admin overview" })).toBeVisible();
    await expect(page.getByTestId("serp-keys")).toBeVisible();
    const nav = page.getByRole("navigation", { name: "Admin" });
    await nav.getByRole("link", { name: "Users", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Users", exact: true, level: 1 })).toBeVisible();
    await nav.getByRole("link", { name: "Plans", exact: true }).click();
    await expect(page.getByTestId("plan-editor-pro")).toBeVisible();
    await nav.getByRole("link", { name: /Billing requests/ }).click();
    await expect(page.getByRole("heading", { name: "Billing requests" })).toBeVisible();
  });
});
