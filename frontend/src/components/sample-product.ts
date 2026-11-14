import type { PreviewProduct, Story } from "./SaamanoPreview";

/**
 * The one product every Template preview shows, so a design can be seen before it is pushed: a real
 * listing ("Smart LED Temperature Display Travel Mug") with its own photos and the AI text saved for it.
 * Fixed text and photos: opening a preview asks the AI for nothing. The photos are in public/template-preview.
 */
const photo = (n: number) => `/template-preview/product-${n}.jpg`;

export const SAMPLE_PRODUCT: PreviewProduct = {
  name: "Smart LED Temperature Display Travel Mug",
  price: "2000",
  description: [
    "Stay informed about your beverage temperature with this sleek travel mug featuring a smart LED display. Its vacuum insulation technology keeps drinks hot or cold for extended periods, making it perfect for on-the-go use. The button for opening ensures easy access while minimizing spills during your travels.",
    "",
    "- 420ml capacity for your favorite beverages",
    "- LED display shows the current drink temperature",
    "- Vacuum insulation maintains temperature effectively",
    "- Stylish black design for a modern look",
    "- Convenient button for easy opening and sipping",
  ].join("\n"),
  images: [1, 2, 3, 4, 5, 6].map(photo),
};

export const SAMPLE_STORY: Story = {
  featureHeading: "Smart Sipping On The Go",
  featureSubheading: "Check your drink's temperature on the LED display and open the mug with a convenient button.",
  featureCards: [
    { title: "LED Display", text: "Shows the current temperature of your drink." },
    { title: "420ml Capacity", text: "Holds 420ml of your favorite beverage." },
    { title: "Easy Opening", text: "A convenient button provides access for opening and sipping." },
    { title: "Black Design", text: "The stylish black finish gives the mug a modern look." },
  ],
  compareIntro: "Choose this travel mug for its 420ml capacity, LED temperature display and convenient button opening. Its black design gives it a modern look.",
  compareRows: ["Shows your drink temperature", "Holds 420ml of your beverage", "Opens with a convenient button", "Features a stylish black design"],
  faq: [
    { question: "What capacity is the travel mug?", answer: "It has a 420ml capacity." },
    { question: "What does the LED display show?", answer: "It shows the current temperature of your drink." },
    { question: "How does the mug open?", answer: "It has a convenient button for opening and sipping." },
    { question: "Can I pay cash on delivery?", answer: "Yes, cash on delivery is available. Delivery costs Rs 250 anywhere in Pakistan." },
  ],
};

/** "You may also like" in the sample: the same mug in the other colours it comes in. */
export const SAMPLE_RELATED: PreviewProduct[] = [
  { name: "Smart LED Travel Mug, Green", price: "2000", description: "", images: [photo(7)] },
  { name: "Smart LED Travel Mug, Red", price: "2000", description: "", images: [photo(8)] },
  { name: "Smart LED Travel Mug, Yellow", price: "2000", description: "", images: [photo(9)] },
  { name: "Smart LED Travel Mug, Blue", price: "2000", description: "", images: [photo(10)] },
];
