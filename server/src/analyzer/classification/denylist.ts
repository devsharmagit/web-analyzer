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

  // 4. Careers/jobs -> careers
  if (/\b(careers?|jobs?|hiring)\b/i.test(text)) {
    return { category: "careers", confidence: 1.0 };
  }

  // 5. Press / media-kit -> media
  if (/\b(press|media-?kit)\b/i.test(text)) {
    return { category: "media", confidence: 1.0 };
  }

  // 6. Generic tag archives -> other
  if (/(^|\/|_|-)tags?(\.php)?\b/i.test(url)) {
    return { category: "other", confidence: 1.0 };
  }

  return null;
}
