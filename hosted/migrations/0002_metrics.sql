CREATE TABLE milestones (
 customer TEXT NOT NULL REFERENCES customers(id), event TEXT NOT NULL,
 day TEXT NOT NULL, PRIMARY KEY(customer,event,day)
);
