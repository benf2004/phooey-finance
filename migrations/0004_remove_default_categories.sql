/* Remove only unused, unmodified categories created by the original installer.
   Referenced or explicitly edited categories belong to the user and are retained. */
WITH defaults(id,name,type,tax_treatment,color) AS (VALUES
('income','Business income','income','business_income','#28634a'),('salary','Salary','income','personal','#28634a'),('software','Software & subscriptions','expense','business_expense','#28634a'),('office','Office & equipment','expense','business_expense','#8c7864'),('travel','Business travel','expense','business_expense','#8c7864'),('dining','Food & dining','expense','personal','#b88a43'),('groceries','Groceries','expense','personal','#8c7864'),('home','Home & utilities','expense','personal','#8c7864'),('shopping','Shopping','expense','personal','#8c7864'),('tax','Tax payments','expense','tax_payment','#b88a43'),('transfer','Transfers','transfer','excluded','#78877d'))
DELETE FROM categories
WHERE EXISTS (
  SELECT 1 FROM defaults d
  WHERE d.id=categories.id AND d.name=categories.name AND d.type=categories.type
    AND d.tax_treatment=categories.tax_treatment AND d.color=categories.color
)
AND NOT EXISTS (SELECT 1 FROM transactions t WHERE t.category_id=categories.id)
AND NOT EXISTS (SELECT 1 FROM splits s WHERE s.category_id=categories.id)
AND NOT EXISTS (SELECT 1 FROM rules r WHERE r.category_id=categories.id)
AND NOT EXISTS (SELECT 1 FROM audit a WHERE a.entity_id=categories.id AND a.action='category.save');
