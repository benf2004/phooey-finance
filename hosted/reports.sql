-- Run on CONTROL. Use monthly cohorts only after they have had time to mature.
WITH first_paid AS (
  SELECT customer, MIN(day) AS paid FROM milestones WHERE event='paid' GROUP BY customer
), outcomes AS (
  SELECT p.customer,p.paid,
    EXISTS(SELECT 1 FROM milestones WHERE customer=p.customer AND event='ledger_loaded' AND day<=date(p.paid,'+7 days'))
    AND EXISTS(SELECT 1 FROM milestones WHERE customer=p.customer AND event='sheet_edit' AND day<=date(p.paid,'+7 days')) AS activated,
    EXISTS(SELECT 1 FROM milestones WHERE customer=p.customer AND event IN ('workspace_visit','sheet_edit','sidebar_visit') AND day BETWEEN date(p.paid,'+1 day') AND date(p.paid,'+30 days')) AS returned
  FROM first_paid p
)
SELECT substr(paid,1,7) AS cohort,COUNT(*) AS paid_customers,
  SUM(CASE WHEN paid<=date('now','-7 days') THEN 1 ELSE 0 END) AS eligible_7d,
  SUM(CASE WHEN paid<=date('now','-7 days') THEN activated ELSE 0 END) AS activated_7d,
  SUM(CASE WHEN paid<=date('now','-30 days') THEN 1 ELSE 0 END) AS eligible_30d,
  SUM(CASE WHEN paid<=date('now','-30 days') THEN returned ELSE 0 END) AS returned_30d
FROM outcomes GROUP BY cohort ORDER BY cohort;
SELECT COUNT(*) AS active_subscribers, COUNT(*)*29 AS gross_annual_recurring_usd FROM customers WHERE paid_until>unixepoch();
