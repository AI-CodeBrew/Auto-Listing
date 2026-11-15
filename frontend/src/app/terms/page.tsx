import type { Metadata } from "next";
import { Legal, LEGAL_CONTACT } from "@/components/Legal";

export const metadata: Metadata = { title: "Terms of service | FynkTech Listing" };

export default function TermsPage() {
  return (
    <Legal title="Terms of service">
      <p>By using FynkTech Listing you agree to these terms.</p>

      <h2>The service</h2>
      <p>
        The app researches products, prepares Shopify listings as drafts and finds video and ad creatives for a product. Results are prepared automatically and can be wrong,
        so review every listing before you publish it.
      </p>

      <h2>Your account</h2>
      <p>Keep your login details private. You are responsible for what is done in your account and for the store you connect to it.</p>

      <h2>Acceptable use</h2>
      <ul>
        <li>Use the app only for products and stores you are allowed to sell and manage.</li>
        <li>Creatives found through YouTube or the Meta Ad Library belong to their owners. They are shown for research. Get permission before you reuse them.</li>
        <li>Do not misuse the app, try to break it, or use it to break the law or the rules of Shopify, Google or Meta.</li>
      </ul>

      <h2>Plans and payment</h2>
      <p>Paid plans are billed as shown on the Billing page. You can cancel at any time and keep access until the end of the period you paid for.</p>

      <h2>Liability</h2>
      <p>The app is provided as it is, without guarantees. To the extent the law allows, we are not liable for lost sales, lost data or other indirect losses.</p>

      <h2>Contact</h2>
      <p>
        Questions: <a href={`mailto:${LEGAL_CONTACT}`}>{LEGAL_CONTACT}</a>.
      </p>
    </Legal>
  );
}
