import type { PreviewProduct, Story } from "./SaamanoPreview";

/**
 * The made-up product the Template page previews, so a design can be seen before it is pushed.
 * Fixed text: opening the preview asks the AI for nothing. The photos are drawings in public/template-preview.
 */
const photo = (n: number) => `/template-preview/bottle-${n}.svg`;

export const SAMPLE_PRODUCT: PreviewProduct = {
  name: "Steel Water Bottle 750 ml",
  price: "2499",
  description: [
    "A double-wall steel bottle that keeps water cold through a long day at work, school or the gym.",
    "",
    "- Double-wall steel: Keeps drinks cold for hours",
    "- Leak-proof cap: Stays dry in your bag",
    "- Carry loop: Easy to hold on the go",
    "- Wide mouth: Fits ice cubes and is easy to clean",
  ].join("\n"),
  images: [1, 2, 3, 4, 5, 6].map(photo),
};

export const SAMPLE_STORY: Story = {
  featureHeading: "Tough & Practical",
  featureSubheading: "A steel bottle made for every day, wherever you go.",
  featureCards: [
    { title: "Stays Cold", text: "Double-wall steel keeps your water cold for hours." },
    { title: "No Leaks", text: "The sealed cap keeps your bag dry." },
    { title: "Built Tough", text: "A strong steel body made for daily use." },
    { title: "Easy Carry", text: "The loop on the cap makes it easy to hold." },
  ],
  topFeaturesSubheading: "Made to keep every drink just right.",
  topFeatures: [
    { title: "Sealed Cap", text: "Leak-proof in any bag." },
    { title: "Wide Mouth", text: "Fits ice cubes, easy to clean." },
    { title: "Cold for Hours", text: "Double walls hold the chill." },
    { title: "Carry Loop", text: "Take it anywhere with one finger." },
  ],
  compareIntro: "A tough steel bottle that keeps water cold and your bag dry, made to last for years of daily use.",
  compareRows: ["Keeps water cold for hours", "Leak-proof sealed cap", "Strong double-wall steel", "Easy to carry and clean"],
  faq: [
    { question: "Can I pay cash on delivery?", answer: "Yes. You pay when the order reaches your door." },
    { question: "Does the cap leak?", answer: "No. The sealed cap is made to stop leaks, so it is safe in a bag." },
    { question: "How much is delivery?", answer: "Rs 250 anywhere in Pakistan." },
    { question: "Do I get a discount on 2 or more?", answer: "Yes. 2 items get 20% off, 3 get 25% and 4 or more get 30%." },
  ],
};

/** "You may also like" in the sample: the same drawings as other products. */
export const SAMPLE_RELATED: PreviewProduct[] = [
  { name: "Steel Water Bottle, Clay", price: "2499", description: "", images: [photo(2)] },
  { name: "Steel Water Bottle, Navy", price: "2499", description: "", images: [photo(3)] },
  { name: "Steel Water Bottle, Sun", price: "2499", description: "", images: [photo(6)] },
  { name: "Bottle Set of 3", price: "6999", description: "", images: [photo(5)] },
];
