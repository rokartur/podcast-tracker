// Predefined guest categories for the finder.
// Each category maps to a topic prompt used to find matching guests via AI.

export type GuestCategory = {
  id: string;
  label: string;
  topic: string;
};

export const GUEST_CATEGORIES: GuestCategory[] = [
  { id: "tech", label: "Technology & IT", topic: "technology, software engineering and IT" },
  { id: "business", label: "Business & Startups", topic: "business, entrepreneurship and startups" },
  { id: "marketing", label: "Marketing & Growth", topic: "marketing, branding and audience growth" },
  { id: "finance", label: "Finance & Investing", topic: "personal finance, investing and economics" },
  { id: "health", label: "Health & Wellness", topic: "health, fitness and mental wellness" },
  { id: "science", label: "Science & Research", topic: "science, research and innovation" },
  { id: "ai", label: "Artificial Intelligence", topic: "artificial intelligence and machine learning" },
  { id: "career", label: "Career & Productivity", topic: "career growth, leadership and productivity" },
  { id: "creators", label: "Creators & Media", topic: "content creation, media and the creator economy" },
  { id: "sports", label: "Sports & Performance", topic: "sports, athletics and high performance" },
];

export function findCategory(id: string): GuestCategory | undefined {
  return GUEST_CATEGORIES.find((c) => c.id === id);
}
