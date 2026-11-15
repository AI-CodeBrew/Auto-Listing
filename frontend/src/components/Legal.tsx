import Link from "next/link";

export const LEGAL_CONTACT = "uzrhsn375@gmail.com";
export const LEGAL_UPDATED = "15 November 2026";

/** The plain page behind the privacy policy, the terms and the data deletion steps. Anyone may open these. */
export function Legal({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <article className="legal">
      <h1>{title}</h1>
      <p className="legal-updated">FynkTech Listing. Last updated {LEGAL_UPDATED}.</p>
      {children}
      <nav className="legal-links">
        <Link href="/privacy">Privacy policy</Link>
        <Link href="/terms">Terms of service</Link>
        <Link href="/data-deletion">Delete your data</Link>
        <Link href="/login">Log in</Link>
      </nav>
    </article>
  );
}
