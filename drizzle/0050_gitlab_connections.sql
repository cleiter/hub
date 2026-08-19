CREATE TABLE "gitlab_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"slug" text NOT NULL,
	"label" text NOT NULL,
	"base_url" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_trigger_routes" DROP CONSTRAINT "project_trigger_routes_provider_check";--> statement-breakpoint
ALTER TABLE "provider_event_receipts" DROP CONSTRAINT "provider_event_receipts_provider_check";--> statement-breakpoint
ALTER TABLE "gitlab_connections" ADD CONSTRAINT "gitlab_connections_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "gitlab_connections" ADD CONSTRAINT "gitlab_connections_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "gitlab_connections_id_organization_unique" ON "gitlab_connections" USING btree ("id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gitlab_connections_organization_slug_unique" ON "gitlab_connections" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "gitlab_connections_organization_idx" ON "gitlab_connections" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "project_trigger_routes" ADD CONSTRAINT "project_trigger_routes_provider_check" CHECK ("project_trigger_routes"."provider" in ('github', 'slack', 'discord', 'linear', 'mattermost', 'gitlab'));--> statement-breakpoint
ALTER TABLE "provider_event_receipts" ADD CONSTRAINT "provider_event_receipts_provider_check" CHECK ("provider_event_receipts"."provider" in ('github', 'slack', 'discord', 'linear', 'mattermost', 'gitlab', 'manual', 'schedule'));