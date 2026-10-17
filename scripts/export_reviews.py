"""
Export recent public Google Play reviews of the Groww app to data/reviews.csv.

  pip install google-play-scraper
  python scripts/export_reviews.py --max 3000 --weeks 12

Keeps only what the analysis needs: a hashed review id, date, rating, review text, thumbs up.
Reviewer names and profile images are never written. Reviews are public Play Store content.
"""
import argparse, csv, datetime as dt, hashlib, os, sys
from google_play_scraper import reviews, Sort

APP_ID = "com.nextbillion.groww"

ap = argparse.ArgumentParser()
ap.add_argument("--max", type=int, default=3000, help="max reviews to fetch")
ap.add_argument("--weeks", type=int, default=12, help="keep reviews from the last N weeks")
ap.add_argument("--out", default=os.path.join(os.path.dirname(__file__), "..", "data", "reviews.csv"))
ap.add_argument("--lang", default="en")
ap.add_argument("--country", default="in")
a = ap.parse_args()

cutoff = dt.datetime.now() - dt.timedelta(weeks=a.weeks)
rows, token = [], None
while len(rows) < a.max:
    batch, token = reviews(APP_ID, lang=a.lang, country=a.country, sort=Sort.NEWEST,
                           count=min(200, a.max - len(rows)), continuation_token=token)
    if not batch:
        break
    rows += batch
    if batch[-1]["at"] < cutoff or token is None:
        break

kept = [r for r in rows if r["at"] >= cutoff and (r.get("content") or "").strip()]
os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
with open(a.out, "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["review_id", "date", "rating", "review", "thumbs_up"])
    for r in kept:
        rid = hashlib.sha1(r["reviewId"].encode()).hexdigest()[:10]
        w.writerow([rid, r["at"].strftime("%Y-%m-%d %H:%M:%S"), r["score"], " ".join(r["content"].split()), r.get("thumbsUpCount", 0)])
print(f"fetched {len(rows)}, kept {len(kept)} from the last {a.weeks} weeks -> {os.path.abspath(a.out)}")
if len(kept) < 100:
    print("warning: fewer than 100 reviews kept; try a larger --max", file=sys.stderr)
