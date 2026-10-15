-- Prices explicitly selected by the owner: annual R$40, lifetime R$120.
insert into billing.prices(product_id,plan,version,currency,amount_cents,active) values
 ('forma-premium','annual',1,'BRL',4000,true),
 ('forma-premium','lifetime',1,'BRL',12000,true);
