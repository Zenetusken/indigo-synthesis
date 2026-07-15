ALTER TABLE "installation_state" ADD COLUMN "product_mutation_epoch" uuid DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
INSERT INTO "installation_state" ("singleton")
VALUES (1)
ON CONFLICT ("singleton") DO NOTHING;
