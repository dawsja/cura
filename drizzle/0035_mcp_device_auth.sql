CREATE TYPE "public"."mcp_device_code_status" AS ENUM('pending', 'approved', 'denied', 'consumed');--> statement-breakpoint
CREATE TYPE "public"."mcp_token_kind" AS ENUM('access', 'refresh');--> statement-breakpoint
CREATE TABLE "mcp_device_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code" text NOT NULL,
	"client_id" text NOT NULL,
	"scope" text NOT NULL,
	"status" "mcp_device_code_status" DEFAULT 'pending' NOT NULL,
	"user_id" text,
	"interval_seconds" integer NOT NULL,
	"last_polled_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_device_codes_device_code_hash_unique" UNIQUE("device_code_hash"),
	CONSTRAINT "mcp_device_codes_user_code_unique" UNIQUE("user_code")
);
--> statement-breakpoint
CREATE TABLE "mcp_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"client_id" text NOT NULL,
	"scope" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mcp_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"user_id" text NOT NULL,
	"kind" "mcp_token_kind" NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"rotated_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "mcp_device_codes" ADD CONSTRAINT "mcp_device_codes_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_grants" ADD CONSTRAINT "mcp_grants_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_grant_id_mcp_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."mcp_grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_mcp_device_codes_expires" ON "mcp_device_codes" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_mcp_grants_user" ON "mcp_grants" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_tokens_grant" ON "mcp_tokens" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "idx_mcp_tokens_expires" ON "mcp_tokens" USING btree ("expires_at");