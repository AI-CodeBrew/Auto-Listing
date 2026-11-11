"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
// The page uses the same stylesheet as the store, so the preview looks like the pushed page.
import "../../theme-templates/fynk-autolisting-product/assets/fynk-autolisting-product.css";
import "./saamano-preview.css";

/**
 * The Saamano product page, drawn in the app from what is entered on Approved listings.
 * Product text and photos come only from the listing. The store-wide lines (delivery, bundle
 * discounts, trust badges) are the theme's own settings from theme-templates/saamano.
 */

export interface PreviewProduct {
  name: string;
  description: string;
  price: string;
  /** Photo URLs in listing order. The first is the main photo. */
  images: string[];
}

// From templates/product.json in the Saamano theme.
const MARQUEE = ["Cash on delivery", "Rs 250 delivery all over Pakistan", "Buy 2 save 20%", "Buy 3 save 25%", "Buy 4 save 30%", "Har ghar ka saamaan"];
const OFFER = [
  { qty: 1, label: "Buy 1", pct: 0, badge: "", note: "Standard price" },
  { qty: 2, label: "Buy 2", pct: 20, badge: "Most popular", note: "" },
  { qty: 3, label: "Buy 3", pct: 25, badge: "Save more", note: "" },
  { qty: 4, label: "Buy 4", pct: 30, badge: "Best value", note: "" },
];
const TRUST = ["Cash on delivery", "Rs 250 delivery, all Pakistan", "Up to 30% off bundles"];
const ORDER_STEPS = ["Order placed", "Dispatched", "Pay at your door"];
const BUNDLE = {
  eyebrow: "Mix and match",
  heading: "Buy more, save up to 30%",
  text: "2 items get 20% off, 3 items get 25% and 4 or more get 30%. Mix any products, and the discount is applied automatically at checkout.",
  steps: ["Pick 2, 3 or 4+ items", "Your discount applies automatically", "Pay cash on delivery"],
  button: "Build your bundle",
};

/** Thumbnails shown at once beside the large photo. */
const THUMBS = 6;

/** Same format as the theme's offer script: "Rs 1,234". */
function rupees(value: number): string {
  return `Rs ${Math.round(value).toLocaleString("en-PK")}`;
}

/** The description split the way the app sends it to Shopify: "- " lines are bullets, the rest are paragraphs. */
function splitDescription(text: string): { paragraphs: string[]; bullets: string[] } {
  const paragraphs: string[] = [];
  const bullets: string[] = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const plain: string[] = [];
    for (const line of lines) {
      if (/^[-*•]\s+/.test(line)) bullets.push(line.replace(/^[-*•]\s+/, ""));
      else plain.push(line);
    }
    if (plain.length) paragraphs.push(plain.join(" "));
  }
  return { paragraphs, bullets };
}

/** "Title: more words" becomes a bold title and a line under it, like the theme's "title | text". */
function highlightParts(bullet: string): [string, string] {
  const match = /^([^:|]{2,60})[:|]\s*(.+)$/.exec(bullet);
  return match ? [match[1].trim(), match[2].trim()] : [bullet, ""];
}

export interface Story {
  compareIntro?: string;
  featureHeading?: string;
  featureSubheading?: string;
  featureCards?: { title: string; text: string }[];
  topFeaturesSubheading?: string;
  topFeatures?: { title: string; text: string }[];
  compareRows: string[];
  faq: { question: string; answer: string }[];
}

/**
 * Asks the app for the AI-written comparison and FAQ. Saved text comes back without a new AI call.
 * A sample (the Template page) brings its own text, so nothing is asked for.
 */
function useStory(productId: string | undefined, name: string, description: string, given: Story | undefined) {
  const [story, setStory] = useState<Story | null>(given ?? null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!given);
  const [round, setRound] = useState(0);

  useEffect(() => {
    if (given || !productId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/products/${productId}/story`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, description, refresh: round > 0 }),
      cache: "no-store",
    })
      .then(async (response) => {
        const body = (await response.json().catch(() => ({}))) as Story & { error?: string };
        if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
        if (!cancelled) {
          setStory({
            featureHeading: body.featureHeading,
            featureSubheading: body.featureSubheading,
            featureCards: body.featureCards,
            topFeaturesSubheading: body.topFeaturesSubheading,
            topFeatures: body.topFeatures,
            compareIntro: body.compareIntro,
            compareRows: body.compareRows,
            faq: body.faq,
          });
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // The text is written once per opening, from what was on screen when the preview opened.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, round]);

  return { story, error, loading, writeAgain: () => setRound((n) => n + 1) };
}

/**
 * A listing's page (productId, with its AI text fetched once), or a sample (sampleStory, from the
 * Template page, with no AI call).
 */
export function SaamanoPreview({
  productId,
  sampleStory,
  product,
  related,
  onClose,
}: {
  productId?: string;
  sampleStory?: Story;
  product: PreviewProduct;
  related: PreviewProduct[];
  onClose: () => void;
}) {
  const [qty, setQty] = useState(2);
  const { story, error: storyError, loading: storyLoading, writeAgain } = useStory(productId, product.name, product.description, sampleStory);
  const price = Number.parseFloat(product.price);
  const hasPrice = Number.isFinite(price) && price > 0;
  const { paragraphs, bullets } = splitDescription(product.description);
  const images = product.images;
  // Each section uses the listing's photos. With few photos, they repeat.
  const photo = (index: number) => (images.length ? images[index % images.length] : null);
  const [active, setActive] = useState(0);
  const shown = active < images.length ? active : 0;
  // The thumbnail column shows THUMBS photos at a time. The arrows move it by one.
  const [firstThumb, setFirst] = useState(0);
  const first = Math.min(firstThumb, Math.max(0, images.length - THUMBS));

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = overflow;
    };
  }, [onClose]);

  // Rendered straight into <body>, so the styles of the card it was opened from never reach it.
  return createPortal(
    <div className="sp-overlay" role="dialog" aria-modal="true" aria-label={`Preview of ${product.name || "this product"}`} data-testid="saamano-preview">
      <div className="sp-bar">
        <div>
          <strong>Saamano product page preview</strong>
          <p className="muted">
            {sampleStory
              ? "A sample product. Each listing shows its own photos and the text your AI writes for it."
              : "Made from this listing. Unsaved changes are included."}
          </p>
        </div>
        <div className="row">
          {!sampleStory && (
            <button type="button" className="btn" onClick={writeAgain} disabled={storyLoading} data-testid="preview-write-again" title="Ask the AI for new comparison and FAQ text">
              {storyLoading ? "Writing text..." : "Write again"}
            </button>
          )}
          <button type="button" className="btn" onClick={onClose} data-testid="preview-close" autoFocus>
            Close
          </button>
        </div>
      </div>
      <div className="sp-scroll">
        <div className="sp">
          {/* On the store the theme's own header stays. Only the product page below is added. */}
          <header className="sp-header" data-testid="preview-store-header">
            <div className="sp-width">
              <span className="sp-logo">Your store&apos;s own header</span>
            </div>
          </header>

          {/* Product information */}
          <section className="sp-width sp-main" data-testid="preview-main">
            <div className="sp-gallery" data-testid="preview-gallery">
              {images.length === 0 && <div className="sp-gallery-empty">No images selected</div>}
              {images.length > 1 && (
                <div className="sp-thumbs" data-testid="preview-thumbs">
                  {images.length > THUMBS && (
                    <button type="button" className="sp-thumbs__arrow" aria-label="Earlier photos" disabled={first === 0} onClick={() => setFirst((n) => Math.max(0, n - 1))}>
                      <span aria-hidden="true">&#8963;</span>
                    </button>
                  )}
                  <div className="sp-thumbs__list" role="list" aria-label="Product photos">
                    {images.slice(first, first + THUMBS).map((src, offset) => {
                      const index = first + offset;
                      return (
                        <button
                          key={`${src}-${index}`}
                          type="button"
                          role="listitem"
                          className={index === shown ? "sp-thumb is-active" : "sp-thumb"}
                          aria-label={`Show photo ${index + 1}`}
                          aria-current={index === shown}
                          onClick={() => setActive(index)}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={src} alt="" />
                        </button>
                      );
                    })}
                  </div>
                  {images.length > THUMBS && (
                    <button
                      type="button"
                      className="sp-thumbs__arrow"
                      aria-label="More photos"
                      disabled={first + THUMBS >= images.length}
                      onClick={() => setFirst((n) => Math.min(images.length - THUMBS, n + 1))}
                    >
                      <span aria-hidden="true">&#8964;</span>
                    </button>
                  )}
                </div>
              )}
              {images.length > 0 && (
                <figure className="sp-gallery__main">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={images[shown]} alt={product.name} data-testid="preview-main-image" />
                </figure>
              )}
            </div>
            <div className="sp-details">
              <div className="sp-head">
                <h1 className="sp-title" data-testid="preview-title">{product.name || "Untitled product"}</h1>
                <p className="sp-price">{hasPrice ? rupees(price) : "No price set"}</p>
              </div>
              {(paragraphs.length > 0 || bullets.length > 0) && (
                <div className="sp-description" data-testid="preview-description">
                  {/* The whole description, as the theme's description block shows it on Shopify. */}
                  {paragraphs.map((text) => (
                    <p key={text}>{text}</p>
                  ))}
                  {bullets.length > 0 && (
                    <ul className="sp-checks">
                      {bullets.slice(0, 5).map((text) => (
                        <li key={text}>
                          <span className="sp-check" aria-hidden="true">
                            &#10003;
                          </span>
                          {text}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
              <div className="so-offer">
                <p className="so-offer__heading">
                  <span>Bundle and save</span>
                </p>
                <div className="so-offer__list" role="radiogroup" aria-label="Bundle and save">
                  {OFFER.map((tier) => {
                    const full = price * tier.qty;
                    const deal = (full * (100 - tier.pct)) / 100;
                    // 4 or more items all get the Buy 4 discount, so that card stays picked above 4.
                    const picked = tier.qty === Math.min(qty, 4);
                    return (
                      <label key={tier.qty} className={picked ? "so-card is-selected" : "so-card"}>
                        <input type="radio" name="sp-qty" value={tier.qty} checked={picked} onChange={() => setQty(tier.qty)} />
                        {tier.badge && <span className="so-card__badge">{tier.badge}</span>}
                        <span className="so-card__dot" aria-hidden="true" />
                        <span className="so-card__thumbs" aria-hidden="true">
                          {photo(0) &&
                            Array.from({ length: tier.qty }, (_, index) => (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img key={index} src={photo(0)!} alt="" />
                            ))}
                        </span>
                        <span className="so-card__main">
                          <span className="so-card__label">{tier.label}</span>
                          {tier.qty > 1 ? (
                            <span className="so-card__save">
                              {hasPrice ? `You save ${rupees(full - deal)} (${tier.pct}% off)` : `${tier.pct}% off`}
                            </span>
                          ) : (
                            <span className="so-card__save so-card__save--muted">{tier.note}</span>
                          )}
                        </span>
                        <span className="so-card__prices">
                          <span className="so-card__price">{hasPrice ? rupees(deal) : "—"}</span>
                          {tier.qty > 1 && hasPrice && <s className="so-card__was">{rupees(full)}</s>}
                        </span>
                      </label>
                    );
                  })}
                </div>
                <p className="so-offer__note">Discount applies automatically at checkout. Mix any products to reach the tier.</p>
              </div>
              <div className="sp-buy" data-testid="preview-buy">
                <div className="sp-qty" role="group" aria-label="Quantity">
                  <button type="button" aria-label="One less" disabled={qty <= 1} onClick={() => setQty((n) => Math.max(1, n - 1))}>
                    &#8722;
                  </button>
                  <span data-testid="preview-qty">{qty}</span>
                  <button type="button" aria-label="One more" disabled={qty >= 99} onClick={() => setQty((n) => Math.min(99, n + 1))}>
                    +
                  </button>
                </div>
                <button type="button" className="sp-button" data-testid="preview-add-to-cart">
                  Add to cart
                </button>
                <button type="button" className="sp-button sp-button-dark">Buy it now</button>
              </div>
              <ul className="sp-delivery">
                <li>Cash on delivery, pay at your door</li>
                <li>Rs 250 delivery all over Pakistan</li>
              </ul>
              <div className="sa-box">
                <ul className="sa-badges">
                  {TRUST.map((badge, index) => (
                    <li key={badge}>
                      <TrustIcon index={index} />
                      <span>{badge}</span>
                    </li>
                  ))}
                </ul>
                <ol className="sa-steps">
                  {ORDER_STEPS.map((step) => (
                    <li key={step}>
                      <span className="sa-steps__dot" />
                      {step}
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </section>

          {/* Saamano product story */}
          <div className="ss-story" data-testid="preview-story">
            <div className="ss-marquee" aria-hidden="true">
              <div className="ss-marquee__track">
                {[0, 1, 2, 3].flatMap((round) =>
                  MARQUEE.map((word) => (
                    <span key={`${round}-${word}`} style={{ display: "contents" }}>
                      <span>{word}</span>
                      <i />
                    </span>
                  )),
                )}
              </div>
            </div>
            <div className="sp-width ss-wrap">
              {story?.featureCards && story.featureCards.length > 0 && (
                <FeatureCards heading={story.featureHeading ?? ""} subheading={story.featureSubheading ?? ""} cards={story.featureCards} photo={photo} />
              )}
              {/* About this product comes straight after the feature cards. */}
              {(photo(1) || paragraphs.length > 0) && (
                <div className="ss-how" data-testid="preview-about">
                  <div className="ss-how__media">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    {photo(1) && <img className="ss-how__img" src={photo(1)!} alt={product.name} />}
                  </div>
                  <div>
                    <p className="ss-eyebrow">About this product</p>
                    <h2 className="ss-title">{product.name || "Untitled product"}</h2>
                    {paragraphs.slice(0, 3).map((text) => (
                      <p key={text} style={{ marginBottom: 12 }}>
                        {text}
                      </p>
                    ))}
                    <button type="button" className="ss-cta">
                      Order now, pay on delivery
                    </button>
                  </div>
                </div>
              )}

              {story?.topFeatures && story.topFeatures.length > 0 && (
                // Same photo as the theme: the third one, or the main photo when there are fewer.
                <TopFeatures subheading={story.topFeaturesSubheading ?? ""} cards={story.topFeatures} src={images[2] ?? images[0] ?? null} alt={product.name} />
              )}

              {bullets.length > 0 && (
                <div data-testid="preview-highlights">
                  <p className="ss-eyebrow">Why you&apos;ll love it</p>
                  <h2 className="ss-title">Made to make everyday life easier</h2>
                  <ul className="ss-highlights">
                    {bullets.slice(0, 4).map((bullet, index) => {
                      const [title, text] = highlightParts(bullet);
                      const src = photo(index + 1);
                      return (
                        <li key={bullet} className={`ss-hl ss-hl--${index % 4}`}>
                          {src && (
                            <span className="ss-hl__photo">
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src={src} alt="" />
                            </span>
                          )}
                          <strong>{title}</strong>
                          {text && <span>{text}</span>}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
              {storyLoading && !story && (
                <p className="sp-story-note" role="status" data-testid="preview-story-loading">
                  The AI is writing the comparison and questions...
                </p>
              )}
              {storyError && (
                <p className="sp-story-note sp-story-error" role="alert" data-testid="preview-story-error">
                  The comparison and questions could not be written: {storyError}
                </p>
              )}

              {story && story.compareRows.length > 0 && (
                <div className="sw" data-testid="preview-compare">
                  <div className="sw-copy">
                    <h2 className="sw-title">Why Choose Us?</h2>
                    {story.compareIntro && <p className="sw-text">{story.compareIntro}</p>}
                    <button type="button" className="sw-btn">
                      Shop now
                    </button>
                  </div>
                  <table className="sw-table">
                    <thead>
                      <tr>
                        <th scope="col">Features</th>
                        <th scope="col" className="sw-us">
                          {photo(0) ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={photo(0)!} alt={product.name} />
                          ) : (
                            "Ours"
                          )}
                        </th>
                        <th scope="col">Others</th>
                      </tr>
                    </thead>
                    <tbody>
                      {story.compareRows.map((row) => (
                        <tr key={row}>
                          <th scope="row">{row}</th>
                          <td className="sw-us">
                            <span className="sw-yes" aria-label="Yes">
                              &#10003;
                            </span>
                          </td>
                          <td>
                            <span className="sw-no" aria-label="No">
                              &#10005;
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {story && story.faq.length > 0 && (
                <div className="ss-faq" data-testid="preview-faq">
                  <p className="ss-eyebrow">Questions</p>
                  <h2 className="ss-title">Good to know</h2>
                  {story.faq.map((item) => (
                    <details key={item.question} className="ss-faq__item">
                      <summary>
                        <span>{item.question}</span>
                        <i aria-hidden="true" />
                      </summary>
                      <p>{item.answer}</p>
                    </details>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Saamano bundle banner */}
          <div className="sb-cta sp-width" data-testid="preview-bundle">
            <div className="sb-cta__card">
              <div className="sb-cta__blocks" aria-hidden="true">
                {[1, 2, 3, 4, 5, 6].map((n) => {
                  const src = photo(n - 1);
                  return (
                    <span key={n} className={`sb-b sb-b--${n}`}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      {src && <img src={src} alt="" />}
                    </span>
                  );
                })}
              </div>
              <div>
                <p className="sb-cta__eyebrow">{BUNDLE.eyebrow}</p>
                <h2 className="sb-cta__title">{BUNDLE.heading}</h2>
                <p className="sb-cta__text">{BUNDLE.text}</p>
                <ol className="sb-cta__steps">
                  {BUNDLE.steps.map((step, index) => (
                    <li key={step}>
                      <span>{index + 1}</span>
                      {step}
                    </li>
                  ))}
                </ol>
                <span className="sb-cta__btn">{BUNDLE.button}</span>
              </div>
            </div>
          </div>

          {/* Product recommendations: the other approved listings */}
          {related.length > 0 && (
            <section className="sp-width sp-related" data-testid="preview-related">
              <h3>You may also like</h3>
              <div className="sp-related-grid">
                {related.slice(0, 4).map((item, index) => {
                  const itemPrice = Number.parseFloat(item.price);
                  return (
                    <div key={`${item.name}-${index}`} className="sp-card">
                      <div className="sp-card__img">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        {item.images[0] && <img src={item.images[0]} alt={item.name} />}
                      </div>
                      <span className="sp-card__title">{item.name || "Untitled product"}</span>
                      <span className="sp-card__price">{Number.isFinite(itemPrice) && itemPrice > 0 ? rupees(itemPrice) : ""}</span>
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          <footer className="sp-footer">
            <div className="sp-width">Your store&apos;s own footer</div>
          </footer>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** A row of cards with a round photo, a title and one line, moved with the arrows. */
function FeatureCards({
  heading,
  subheading,
  cards,
  photo,
}: {
  heading: string;
  subheading: string;
  cards: { title: string; text: string }[];
  photo: (index: number) => string | null;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });

  const measure = () => {
    const el = track.current;
    if (!el) return;
    setEdges({ start: el.scrollLeft <= 2, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 2 });
  };

  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [cards.length]);

  const move = (direction: 1 | -1) => {
    const el = track.current;
    const card = el?.querySelector<HTMLElement>(".sf-card");
    if (!el || !card) return;
    el.scrollBy({ left: direction * (card.offsetWidth + 20), behavior: "smooth" });
  };

  return (
    <div className="sf" data-testid="preview-features">
      {heading && <h2 className="sf-title">{heading}</h2>}
      {subheading && <p className="sf-sub">{subheading}</p>}
      <div className="sf-track" ref={track} onScroll={measure}>
        {cards.map((card, index) => {
          // The main photo is shown up top already, so the cards start from the second one.
          const src = photo(index + 1);
          return (
            <div key={card.title} className="sf-card">
              <span className="sf-photo">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {src && <img src={src} alt="" />}
              </span>
              <h3>{card.title}</h3>
              <p>{card.text}</p>
            </div>
          );
        })}
      </div>
      {!(edges.start && edges.end) && (
        <div className="sf-arrows">
          <button type="button" aria-label="Previous" disabled={edges.start} onClick={() => move(-1)}>
            &#8249;
          </button>
          <button type="button" aria-label="Next" disabled={edges.end} onClick={() => move(1)}>
            &#8250;
          </button>
        </div>
      )}
    </div>
  );
}

/** "Top Features": two cards on each side of one large photo, as in the theme. */
function TopFeatures({ subheading, cards, src, alt }: { subheading: string; cards: { title: string; text: string }[]; src: string | null; alt: string }) {
  const column = (list: { title: string; text: string }[]) => (
    <div className="stf-col">
      {list.map((card) => (
        <div key={card.title} className="stf-card">
          <h3>{card.title}</h3>
          <p>{card.text}</p>
        </div>
      ))}
    </div>
  );
  return (
    <div className="stf" data-testid="preview-top-features">
      <h2 className="stf-title">Top Features</h2>
      {subheading && <p className="stf-sub">{subheading}</p>}
      <div className={src ? "stf-grid" : "stf-grid stf-grid--no-photo"}>
        {column(cards.slice(0, 2))}
        {src && (
          <div className="stf-media">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="stf-img" src={src} alt={alt} />
          </div>
        )}
        {column(cards.slice(2, 4))}
      </div>
    </div>
  );
}

function TrustIcon({ index }: { index: number }) {
  const props = { "aria-hidden": true, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  if (index === 0) {
    return (
      <svg {...props}>
        <rect x="2" y="6" width="20" height="12" rx="2" />
        <circle cx="12" cy="12" r="2.5" />
      </svg>
    );
  }
  if (index === 1) {
    return (
      <svg {...props}>
        <path d="M3 6h11v10H3z" />
        <path d="M14 9h4l3 3v4h-7" />
        <circle cx="7" cy="17.5" r="1.8" />
        <circle cx="17" cy="17.5" r="1.8" />
      </svg>
    );
  }
  return (
    <svg {...props}>
      <rect x="3" y="8" width="18" height="4" rx="1" />
      <path d="M12 8v13" />
      <path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" />
    </svg>
  );
}
