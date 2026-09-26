export function checkDenylist(url: string, title: string): { category: string; confidence: number } | null {
  const text = `${url} ${title}`.toLowerCase();

  // 1. Referral/rewards/loyalty/gift-card terms -> offers
  if (/\b(refer|referral|referrals|reward|rewards|loyalty|gift-?cards?)\b/i.test(text)) {
    return { category: "offers", confidence: 1.0 };
  }

  // 2. Events/calendar terms -> core (or events if approved)
  if (/\b(events?|calendar)\b/i.test(text)) {
    return { category: "events", confidence: 1.0 };
  }

  // 3. Training/university/academy/injector-training terms -> education
  if (/\b(training|university|academy|classes|class|courses|course)\b/i.test(text)) {
    return { category: "education", confidence: 1.0 };
  }

  // 4. Careers/jobs/press/media-kit terms -> other
  if (/\b(careers?|jobs?|hiring|press|media-?kit)\b/i.test(text)) {
    return { category: "other", confidence: 1.0 };
  }

  return null;
}
