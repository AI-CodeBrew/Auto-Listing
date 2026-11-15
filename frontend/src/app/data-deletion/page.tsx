import type { Metadata } from "next";
import { Legal, LEGAL_CONTACT } from "@/components/Legal";

export const metadata: Metadata = { title: "Delete your data | FynkTech Listing" };

export default function DataDeletionPage() {
  return (
    <Legal title="Delete your data">
      <p>You can have your account and everything saved in it deleted at any time.</p>

      <h2>How to ask</h2>
      <ol>
        <li>
          Send an email to <a href={`mailto:${LEGAL_CONTACT}?subject=Delete%20my%20data`}>{LEGAL_CONTACT}</a> from the address you signed up with.
        </li>
        <li>Use the subject &quot;Delete my data&quot;.</li>
        <li>We confirm by email and delete your data within 30 days.</li>
      </ol>

      <h2>What is deleted</h2>
      <ul>
        <li>Your account details.</li>
        <li>Your saved Shopify connection details.</li>
        <li>Your products, photos, listings, creatives results and history.</li>
      </ul>
      <p>Products already created in your Shopify store stay there, because they belong to your store. Payment records we must keep by law are kept only as long as required.</p>

      <h2>Facebook and Instagram</h2>
      <p>
        The app does not collect Facebook or Instagram account data. It only searches the public Meta Ad Library, so there is no Facebook data about you for us to delete.
      </p>
    </Legal>
  );
}
