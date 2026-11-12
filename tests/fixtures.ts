// Opt-in fixtures; application migrations must never create categories.
export const categoryFixtures = `INSERT INTO categories(id,name,type,tax_treatment,color) VALUES
('office','Office & equipment','expense','business_expense','#8c7864'),
('groceries','Groceries','expense','personal','#8c7864');`;
