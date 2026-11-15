import type { Metadata } from "next";
import { Legal, LEGAL_CONTACT } from "@/components/Legal";

export const metadata: Metadata = { title: "Privacy policy | FynkTech Listing" };

export default function PrivacyPage() {
  return (
    <Legal title="Privacy policy">
      <p>
        FynkTech Listing helps online sellers research a product, prepare a Shopify listing for it and find video and ad creatives for it. This page explains what the app
        stores and why.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li><strong>Account details:</strong> your name, email address and a protected (hashed) form of your password.</li>
        <li><strong>Store connection:</strong> your Shopify store address and the access details you enter, used only to create draft products in your own store.</li>
        <li><strong>Your work:</strong> the product names, photos, links and listing text you add or that the app prepares for you, and a history of your runs.</li>
        <li><strong>Billing and usage:</strong> your plan, payment status and how many runs you have used. Card details are handled by the payment provider and never reach us.</li>
        <li><strong>A login cookie</strong> that keeps you signed in. We do not use advertising or tracking cookies.</li>
      </ul>

      <h2>Information from Meta (Facebook and Instagram)</h2>
      <p>
        The Find Creatives feature searches the public Meta Ad Library for ads that match a product. It reads only what Meta publishes there: the ad text, the page name,
        the dates an ad ran, its reach and a link to the ad. The app does not ask you to log in with Facebook and does not read, store or share anyone&apos;s Facebook or
        Instagram profile, friends, messages, pages or ad accounts.
      </p>

      <h2>How we use it</h2>
      <ul>
        <li>To run the app for you: research products, build listings, send drafts to your store and show matching creatives.</li>
        <li>To keep your account secure, apply your plan limits and fix problems.</li>
      </ul>
      <p>We do not sell your information and do not use it for advertising.</p>

      <h2>Who else handles it</h2>
      <p>
        We rely on service providers to host the app, store its database and files, take payments, and run the searches and AI that prepare a listing. They receive only what
        is needed for that job, for example a product name or photo. Your Shopify details are sent only to Shopify.
      </p>

      <h2>How long we keep it</h2>
      <p>We keep your information while your account is open. When you ask us to delete your account, we delete it and your saved work within 30 days.</p>

      <h2>Your choices</h2>
      <p>
        You can ask for a copy of your information, correct it, or have it deleted. See <a href="/data-deletion">Delete your data</a>, or write to{" "}
        <a href={`mailto:${LEGAL_CONTACT}`}>{LEGAL_CONTACT}</a>.
      </p>

      <h2>Changes</h2>
      <p>If this policy changes, the new version is posted on this page with a new date.</p>
    </Legal>
  );
}
