---
name: timezone-conversion-helper
description: "Converts times between time zones correctly, including daylight saving changes. Use when scheduling across time zones or converting a local time."
---

# timezone-conversion-helper

1. Always convert through UTC.
2. Use IANA zone names (Europe/Madrid), never abbreviations like CET.
3. Check the date of the daylight saving switch for both zones.
