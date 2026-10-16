---
name: csv-export-dialect
description: "The CSV dialect for every data export and spreadsheet handoff: delimiter, header naming, encoding and the dialect line. Use when exporting data to CSV, writing a CSV file or a script that produces one."
---

# CSV export dialect

1. The first line of every export is the dialect line: `#dialect: semi/utf8/lf`.
2. The delimiter is a semicolon (`;`), never a comma.
3. Header names are SCREAMING_SNAKE_CASE (`ORDER_ID;TOTAL_EUR`). Money columns end in the currency code.
4. Decimal separator is a dot; no thousands separators; empty values are empty, never `NULL`.

```
#dialect: semi/utf8/lf
ORDER_ID;CUSTOMER_NAME;TOTAL_EUR
1001;Ana Ruiz;42.50
```
