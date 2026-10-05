-- Append-only guards (PRD §41: audit records immutable; master prompt §53: never overwrite
-- historical decisions). Applies to every role used by the application. A DBA can still
-- disable the trigger deliberately, which is itself visible in the database logs.
CREATE OR REPLACE FUNCTION alvip_reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only (% not permitted)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION alvip_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION alvip_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER human_reviews_append_only
  BEFORE UPDATE OR DELETE ON human_reviews
  FOR EACH ROW EXECUTE FUNCTION alvip_reject_mutation();
--> statement-breakpoint
CREATE TRIGGER feedback_append_only
  BEFORE UPDATE OR DELETE ON feedback
  FOR EACH ROW EXECUTE FUNCTION alvip_reject_mutation();
--> statement-breakpoint
-- Versioned config rows: content is immutable; only the is_active flag may change.
CREATE OR REPLACE FUNCTION alvip_config_content_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'table % rows cannot be deleted (versioned config)', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (to_jsonb(NEW) - 'is_active') IS DISTINCT FROM (to_jsonb(OLD) - 'is_active') THEN
    RAISE EXCEPTION 'table % content is immutable; create a new version', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER client_profiles_immutable
  BEFORE UPDATE OR DELETE ON client_profiles
  FOR EACH ROW EXECUTE FUNCTION alvip_config_content_immutable();
--> statement-breakpoint
CREATE TRIGGER service_rule_versions_immutable
  BEFORE UPDATE OR DELETE ON service_rule_versions
  FOR EACH ROW EXECUTE FUNCTION alvip_config_content_immutable();
--> statement-breakpoint
CREATE TRIGGER threshold_versions_immutable
  BEFORE UPDATE OR DELETE ON threshold_versions
  FOR EACH ROW EXECUTE FUNCTION alvip_config_content_immutable();
