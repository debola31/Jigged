export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      ai_chat_queries: {
        Row: {
          chart_config: Json | null
          company_id: string
          created_at: string
          duration_ms: number | null
          id: string
          model: string | null
          provider: string
          question: string
          response: string
          tokens_used: number | null
          tool_calls: Json
        }
        Insert: {
          chart_config?: Json | null
          company_id: string
          created_at?: string
          duration_ms?: number | null
          id?: string
          model?: string | null
          provider: string
          question: string
          response: string
          tokens_used?: number | null
          tool_calls?: Json
        }
        Update: {
          chart_config?: Json | null
          company_id?: string
          created_at?: string
          duration_ms?: number | null
          id?: string
          model?: string | null
          provider?: string
          question?: string
          response?: string
          tokens_used?: number | null
          tool_calls?: Json
        }
        Relationships: [
          {
            foreignKeyName: "ai_chat_queries_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      ai_config: {
        Row: {
          company_id: string
          created_at: string | null
          feature: string
          id: string
          model: string | null
          provider: string
          settings: Json | null
          updated_at: string | null
        }
        Insert: {
          company_id: string
          created_at?: string | null
          feature: string
          id?: string
          model?: string | null
          provider?: string
          settings?: Json | null
          updated_at?: string | null
        }
        Update: {
          company_id?: string
          created_at?: string | null
          feature?: string
          id?: string
          model?: string | null
          provider?: string
          settings?: Json | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ai_config_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      auth_audit_log: {
        Row: {
          actor_user_id: string | null
          company_id: string | null
          created_at: string
          error_detail: string | null
          event_type: string
          id: string
          outcome: string
          target_user_id: string | null
        }
        Insert: {
          actor_user_id?: string | null
          company_id?: string | null
          created_at?: string
          error_detail?: string | null
          event_type: string
          id?: string
          outcome: string
          target_user_id?: string | null
        }
        Update: {
          actor_user_id?: string | null
          company_id?: string | null
          created_at?: string
          error_detail?: string | null
          event_type?: string
          id?: string
          outcome?: string
          target_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "auth_audit_log_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      companies: {
        Row: {
          address_line1: string | null
          address_line2: string | null
          city: string | null
          country: string | null
          created_at: string | null
          default_markup_bought_percent: number
          default_markup_made_percent: number
          default_material_charge_basis: string
          demo_company_id: string | null
          email: string | null
          id: string
          is_demo: boolean | null
          logo_url: string | null
          name: string
          phone: string | null
          postal_code: string | null
          settings: Json | null
          slug: string | null
          state: string | null
          updated_at: string | null
          website: string | null
        }
        Insert: {
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          country?: string | null
          created_at?: string | null
          default_markup_bought_percent?: number
          default_markup_made_percent?: number
          default_material_charge_basis?: string
          demo_company_id?: string | null
          email?: string | null
          id?: string
          is_demo?: boolean | null
          logo_url?: string | null
          name: string
          phone?: string | null
          postal_code?: string | null
          settings?: Json | null
          slug?: string | null
          state?: string | null
          updated_at?: string | null
          website?: string | null
        }
        Update: {
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          country?: string | null
          created_at?: string | null
          default_markup_bought_percent?: number
          default_markup_made_percent?: number
          default_material_charge_basis?: string
          demo_company_id?: string | null
          email?: string | null
          id?: string
          is_demo?: boolean | null
          logo_url?: string | null
          name?: string
          phone?: string | null
          postal_code?: string | null
          settings?: Json | null
          slug?: string | null
          state?: string | null
          updated_at?: string | null
          website?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "companies_demo_company_id_fkey"
            columns: ["demo_company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      company_billing: {
        Row: {
          billing_exempt: boolean
          cancel_at: string | null
          canceled_at: string | null
          company_id: string
          created_at: string
          current_period_end: string | null
          ended_at: string | null
          override_price_id: string | null
          override_trial_days: number | null
          stripe_customer_id: string | null
          stripe_subscription_id: string | null
          subscription_event_at: string | null
          subscription_price_id: string | null
          subscription_status: string | null
          synced_at: string
          trial_end: string | null
          updated_at: string
        }
        Insert: {
          billing_exempt?: boolean
          cancel_at?: string | null
          canceled_at?: string | null
          company_id: string
          created_at?: string
          current_period_end?: string | null
          ended_at?: string | null
          override_price_id?: string | null
          override_trial_days?: number | null
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          subscription_event_at?: string | null
          subscription_price_id?: string | null
          subscription_status?: string | null
          synced_at?: string
          trial_end?: string | null
          updated_at?: string
        }
        Update: {
          billing_exempt?: boolean
          cancel_at?: string | null
          canceled_at?: string | null
          company_id?: string
          created_at?: string
          current_period_end?: string | null
          ended_at?: string | null
          override_price_id?: string | null
          override_trial_days?: number | null
          stripe_customer_id?: string | null
          stripe_subscription_id?: string | null
          subscription_event_at?: string | null
          subscription_price_id?: string | null
          subscription_status?: string | null
          synced_at?: string
          trial_end?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_billing_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: true
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      company_custom_units: {
        Row: {
          company_id: string
          created_at: string | null
          id: string
          unit_name: string
        }
        Insert: {
          company_id: string
          created_at?: string | null
          id?: string
          unit_name: string
        }
        Update: {
          company_id?: string
          created_at?: string | null
          id?: string
          unit_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_custom_units_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      company_order_counters: {
        Row: {
          company_id: string
          next_number: number
          updated_at: string
        }
        Insert: {
          company_id: string
          next_number?: number
          updated_at?: string
        }
        Update: {
          company_id?: string
          next_number?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "company_order_counters_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: true
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_addresses: {
        Row: {
          address_line1: string | null
          address_line2: string | null
          attention_to: string | null
          city: string | null
          country: string | null
          created_at: string
          customer_id: string
          default_billing: boolean
          default_shipping: boolean
          id: string
          postal_code: string | null
          state: string | null
          updated_at: string
        }
        Insert: {
          address_line1?: string | null
          address_line2?: string | null
          attention_to?: string | null
          city?: string | null
          country?: string | null
          created_at?: string
          customer_id: string
          default_billing?: boolean
          default_shipping?: boolean
          id?: string
          postal_code?: string | null
          state?: string | null
          updated_at?: string
        }
        Update: {
          address_line1?: string | null
          address_line2?: string | null
          attention_to?: string | null
          city?: string | null
          country?: string | null
          created_at?: string
          customer_id?: string
          default_billing?: boolean
          default_shipping?: boolean
          id?: string
          postal_code?: string | null
          state?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_addresses_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_carrier_accounts: {
        Row: {
          account_country_code: string
          account_number: string | null
          account_postal_code: string | null
          bill_to_party: string
          carrier: string
          company_id: string
          created_at: string
          customer_id: string
          deleted_at: string | null
          id: string
          notes: string | null
          updated_at: string
        }
        Insert: {
          account_country_code?: string
          account_number?: string | null
          account_postal_code?: string | null
          bill_to_party: string
          carrier: string
          company_id: string
          created_at?: string
          customer_id: string
          deleted_at?: string | null
          id?: string
          notes?: string | null
          updated_at?: string
        }
        Update: {
          account_country_code?: string
          account_number?: string | null
          account_postal_code?: string | null
          bill_to_party?: string
          carrier?: string
          company_id?: string
          created_at?: string
          customer_id?: string
          deleted_at?: string | null
          id?: string
          notes?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_carrier_accounts_company_fk"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_carrier_accounts_customer_fk"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_contacts: {
        Row: {
          created_at: string
          customer_id: string
          deleted_at: string | null
          email: string | null
          id: string
          is_billing_default: boolean
          is_primary: boolean
          name: string
          phone: string | null
          role: string
          role_label: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          customer_id: string
          deleted_at?: string | null
          email?: string | null
          id?: string
          is_billing_default?: boolean
          is_primary?: boolean
          name: string
          phone?: string | null
          role: string
          role_label?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          customer_id?: string
          deleted_at?: string | null
          email?: string | null
          id?: string
          is_billing_default?: boolean
          is_primary?: boolean
          name?: string
          phone?: string | null
          role?: string
          role_label?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_contacts_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          company_id: string
          created_at: string | null
          credit_hold_note: string | null
          credit_status: string
          default_payment_terms: string | null
          deleted_at: string | null
          id: string
          name: string
          updated_at: string | null
        }
        Insert: {
          company_id: string
          created_at?: string | null
          credit_hold_note?: string | null
          credit_status?: string
          default_payment_terms?: string | null
          deleted_at?: string | null
          id?: string
          name: string
          updated_at?: string | null
        }
        Update: {
          company_id?: string
          created_at?: string | null
          credit_hold_note?: string | null
          credit_status?: string
          default_payment_terms?: string | null
          deleted_at?: string | null
          id?: string
          name?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customers_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      demo_data_templates: {
        Row: {
          created_at: string | null
          created_by: string | null
          id: string
          is_active: boolean | null
          name: string
          template_data: Json
          version: number
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          id?: string
          is_active?: boolean | null
          name: string
          template_data: Json
          version?: number
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          id?: string
          is_active?: boolean | null
          name?: string
          template_data?: Json
          version?: number
        }
        Relationships: []
      }
      feedback: {
        Row: {
          company_id: string
          created_at: string
          feedback_text: string
          id: string
          page_path: string
          page_title: string
          user_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          feedback_text: string
          id?: string
          page_path: string
          page_title: string
          user_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          feedback_text?: string
          id?: string
          page_path?: string
          page_title?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "feedback_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_locations: {
        Row: {
          company_id: string
          created_at: string
          id: string
          kind: string | null
          name: string
          parent_id: string | null
          sort_order: number
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          id?: string
          kind?: string | null
          name: string
          parent_id?: string | null
          sort_order?: number
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          id?: string
          kind?: string | null
          name?: string
          parent_id?: string | null
          sort_order?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_locations_company_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_locations_parent_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "inventory_locations"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_transactions: {
        Row: {
          company_id: string
          converted_quantity: number
          created_at: string | null
          created_by: string | null
          has_discrepancy: boolean
          id: string
          item_name: string
          job_id: string | null
          job_operation_id: string | null
          location_id: string | null
          location_name: string | null
          notes: string | null
          operator_id: string | null
          part_id: string | null
          photo_path: string | null
          quantity: number
          transfer_group_id: string | null
          type: string
          unit: string
        }
        Insert: {
          company_id: string
          converted_quantity: number
          created_at?: string | null
          created_by?: string | null
          has_discrepancy?: boolean
          id?: string
          item_name: string
          job_id?: string | null
          job_operation_id?: string | null
          location_id?: string | null
          location_name?: string | null
          notes?: string | null
          operator_id?: string | null
          part_id?: string | null
          photo_path?: string | null
          quantity: number
          transfer_group_id?: string | null
          type: string
          unit: string
        }
        Update: {
          company_id?: string
          converted_quantity?: number
          created_at?: string | null
          created_by?: string | null
          has_discrepancy?: boolean
          id?: string
          item_name?: string
          job_id?: string | null
          job_operation_id?: string | null
          location_id?: string | null
          location_name?: string | null
          notes?: string | null
          operator_id?: string | null
          part_id?: string | null
          photo_path?: string | null
          quantity?: number
          transfer_group_id?: string | null
          type?: string
          unit?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_transactions_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_transactions_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_transactions_job_operation_id_fkey"
            columns: ["job_operation_id"]
            isOneToOne: false
            referencedRelation: "job_operations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_transactions_location_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "inventory_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_transactions_part_id_fkey"
            columns: ["part_id"]
            isOneToOne: false
            referencedRelation: "parts"
            referencedColumns: ["id"]
          },
        ]
      }
      invitations: {
        Row: {
          accepted_at: string | null
          accepted_by: string | null
          company_id: string
          created_at: string | null
          email: string
          expires_at: string
          id: string
          invited_by: string
          role: string
          status: string | null
        }
        Insert: {
          accepted_at?: string | null
          accepted_by?: string | null
          company_id: string
          created_at?: string | null
          email: string
          expires_at: string
          id?: string
          invited_by: string
          role: string
          status?: string | null
        }
        Update: {
          accepted_at?: string | null
          accepted_by?: string | null
          company_id?: string
          created_at?: string | null
          email?: string
          expires_at?: string
          id?: string
          invited_by?: string
          role?: string
          status?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invitations_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      job_attachments: {
        Row: {
          company_id: string
          created_at: string
          file_name: string
          id: string
          job_id: string
          mime_type: string | null
          size_bytes: number | null
          storage_path: string
          uploaded_by: string | null
        }
        Insert: {
          company_id: string
          created_at?: string
          file_name: string
          id?: string
          job_id: string
          mime_type?: string | null
          size_bytes?: number | null
          storage_path: string
          uploaded_by?: string | null
        }
        Update: {
          company_id?: string
          created_at?: string
          file_name?: string
          id?: string
          job_id?: string
          mime_type?: string | null
          size_bytes?: number | null
          storage_path?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_attachments_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_attachments_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      job_fulfillment_audit: {
        Row: {
          company_id: string
          created_at: string
          from_status: string | null
          id: string
          job_id: string
          to_status: string
          triggering_shipment_id: string | null
          triggering_user_id: string | null
        }
        Insert: {
          company_id: string
          created_at?: string
          from_status?: string | null
          id?: string
          job_id: string
          to_status: string
          triggering_shipment_id?: string | null
          triggering_user_id?: string | null
        }
        Update: {
          company_id?: string
          created_at?: string
          from_status?: string | null
          id?: string
          job_id?: string
          to_status?: string
          triggering_shipment_id?: string | null
          triggering_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_fulfillment_audit_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_fulfillment_audit_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_fulfillment_audit_triggering_shipment_id_fkey"
            columns: ["triggering_shipment_id"]
            isOneToOne: false
            referencedRelation: "shipments"
            referencedColumns: ["id"]
          },
        ]
      }
      job_materials: {
        Row: {
          created_at: string
          expected_quantity: number
          id: string
          job_id: string
          job_part_id: string
          material_part_id: string
          parts_bom_id: string | null
          unit: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          expected_quantity?: number
          id?: string
          job_id: string
          job_part_id: string
          material_part_id: string
          parts_bom_id?: string | null
          unit: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          expected_quantity?: number
          id?: string
          job_id?: string
          job_part_id?: string
          material_part_id?: string
          parts_bom_id?: string | null
          unit?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_materials_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_materials_job_part_id_fkey"
            columns: ["job_part_id"]
            isOneToOne: false
            referencedRelation: "job_parts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_materials_material_part_id_fkey"
            columns: ["material_part_id"]
            isOneToOne: false
            referencedRelation: "parts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_materials_parts_bom_id_fkey"
            columns: ["parts_bom_id"]
            isOneToOne: false
            referencedRelation: "parts_bom"
            referencedColumns: ["id"]
          },
        ]
      }
      job_operation_completions: {
        Row: {
          company_id: string
          completed_at: string
          completed_by: string | null
          created_at: string
          id: string
          job_operation_id: string
          job_part_id: string
          note: string | null
          quantity_good: number
          updated_at: string
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          company_id: string
          completed_at?: string
          completed_by?: string | null
          created_at?: string
          id?: string
          job_operation_id: string
          job_part_id: string
          note?: string | null
          quantity_good: number
          updated_at?: string
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          company_id?: string
          completed_at?: string
          completed_by?: string | null
          created_at?: string
          id?: string
          job_operation_id?: string
          job_part_id?: string
          note?: string | null
          quantity_good?: number
          updated_at?: string
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_op_completions_company_fk"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_op_completions_job_part_fk"
            columns: ["job_part_id"]
            isOneToOne: false
            referencedRelation: "job_parts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_op_completions_operation_fk"
            columns: ["job_operation_id"]
            isOneToOne: false
            referencedRelation: "job_operations"
            referencedColumns: ["id"]
          },
        ]
      }
      job_operation_intervals: {
        Row: {
          adjusted_at: string | null
          adjusted_by: string | null
          adjusted_ended_at: string | null
          adjusted_started_at: string | null
          capture_source: string
          close_reason: string | null
          company_id: string
          completion_id: string | null
          created_at: string
          effective_ended_at: string | null
          effective_started_at: string | null
          ended_at: string | null
          id: string
          job_operation_id: string
          job_part_id: string
          note: string | null
          operator_id: string
          started_at: string
          updated_at: string
          voided_at: string | null
          voided_by: string | null
          work_center_id: string | null
        }
        Insert: {
          adjusted_at?: string | null
          adjusted_by?: string | null
          adjusted_ended_at?: string | null
          adjusted_started_at?: string | null
          capture_source?: string
          close_reason?: string | null
          company_id: string
          completion_id?: string | null
          created_at?: string
          effective_ended_at?: string | null
          effective_started_at?: string | null
          ended_at?: string | null
          id?: string
          job_operation_id: string
          job_part_id: string
          note?: string | null
          operator_id: string
          started_at?: string
          updated_at?: string
          voided_at?: string | null
          voided_by?: string | null
          work_center_id?: string | null
        }
        Update: {
          adjusted_at?: string | null
          adjusted_by?: string | null
          adjusted_ended_at?: string | null
          adjusted_started_at?: string | null
          capture_source?: string
          close_reason?: string | null
          company_id?: string
          completion_id?: string | null
          created_at?: string
          effective_ended_at?: string | null
          effective_started_at?: string | null
          ended_at?: string | null
          id?: string
          job_operation_id?: string
          job_part_id?: string
          note?: string | null
          operator_id?: string
          started_at?: string
          updated_at?: string
          voided_at?: string | null
          voided_by?: string | null
          work_center_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_op_intervals_adjusted_by_fk"
            columns: ["adjusted_by"]
            isOneToOne: false
            referencedRelation: "user_company_access"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_op_intervals_company_fk"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_op_intervals_completion_fk"
            columns: ["completion_id"]
            isOneToOne: false
            referencedRelation: "job_operation_completions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_op_intervals_job_part_fk"
            columns: ["job_part_id"]
            isOneToOne: false
            referencedRelation: "job_parts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_op_intervals_operation_fk"
            columns: ["job_operation_id"]
            isOneToOne: false
            referencedRelation: "job_operations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_op_intervals_operator_fk"
            columns: ["operator_id"]
            isOneToOne: false
            referencedRelation: "user_company_access"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_op_intervals_voided_by_fk"
            columns: ["voided_by"]
            isOneToOne: false
            referencedRelation: "user_company_access"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_op_intervals_work_center_fk"
            columns: ["work_center_id"]
            isOneToOne: false
            referencedRelation: "work_centers"
            referencedColumns: ["id"]
          },
        ]
      }
      job_operations: {
        Row: {
          completed_at: string | null
          completed_by: string | null
          created_at: string | null
          estimated_run_minutes_per_unit: number | null
          estimated_setup_minutes: number | null
          external_unit_price_snapshot: number | null
          id: string
          instructions: string | null
          job_id: string
          job_part_id: string
          labor_rate_snapshot: number | null
          notes: string | null
          operation_name: string
          routing_operation_id: string | null
          sent_at: string | null
          sent_by: string | null
          sequence: number
          status: string
          updated_at: string | null
          work_center_id: string | null
          work_center_kind_snapshot: string | null
        }
        Insert: {
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string | null
          estimated_run_minutes_per_unit?: number | null
          estimated_setup_minutes?: number | null
          external_unit_price_snapshot?: number | null
          id?: string
          instructions?: string | null
          job_id: string
          job_part_id: string
          labor_rate_snapshot?: number | null
          notes?: string | null
          operation_name: string
          routing_operation_id?: string | null
          sent_at?: string | null
          sent_by?: string | null
          sequence: number
          status?: string
          updated_at?: string | null
          work_center_id?: string | null
          work_center_kind_snapshot?: string | null
        }
        Update: {
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string | null
          estimated_run_minutes_per_unit?: number | null
          estimated_setup_minutes?: number | null
          external_unit_price_snapshot?: number | null
          id?: string
          instructions?: string | null
          job_id?: string
          job_part_id?: string
          labor_rate_snapshot?: number | null
          notes?: string | null
          operation_name?: string
          routing_operation_id?: string | null
          sent_at?: string | null
          sent_by?: string | null
          sequence?: number
          status?: string
          updated_at?: string | null
          work_center_id?: string | null
          work_center_kind_snapshot?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "job_operations_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_operations_job_part_id_fkey"
            columns: ["job_part_id"]
            isOneToOne: false
            referencedRelation: "job_parts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_operations_routing_operation_id_fkey"
            columns: ["routing_operation_id"]
            isOneToOne: false
            referencedRelation: "routing_operations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_operations_work_center_id_fkey"
            columns: ["work_center_id"]
            isOneToOne: false
            referencedRelation: "work_centers"
            referencedColumns: ["id"]
          },
        ]
      }
      job_parts: {
        Row: {
          company_id: string
          completed_at: string | null
          created_at: string
          current_operation_sequence: number | null
          fulfillment_status: string
          id: string
          invoicing_status: string
          job_id: string
          part_id: string
          production_status: string
          quantity: number
          sequence: number
          source_quote_line_item_id: string | null
          started_at: string | null
          status_changed_at: string | null
          total_price: number | null
          true_cost_per_unit: number | null
          unit_price: number | null
          updated_at: string
        }
        Insert: {
          company_id: string
          completed_at?: string | null
          created_at?: string
          current_operation_sequence?: number | null
          fulfillment_status: string
          id?: string
          invoicing_status?: string
          job_id: string
          part_id: string
          production_status: string
          quantity: number
          sequence: number
          source_quote_line_item_id?: string | null
          started_at?: string | null
          status_changed_at?: string | null
          total_price?: number | null
          true_cost_per_unit?: number | null
          unit_price?: number | null
          updated_at?: string
        }
        Update: {
          company_id?: string
          completed_at?: string | null
          created_at?: string
          current_operation_sequence?: number | null
          fulfillment_status?: string
          id?: string
          invoicing_status?: string
          job_id?: string
          part_id?: string
          production_status?: string
          quantity?: number
          sequence?: number
          source_quote_line_item_id?: string | null
          started_at?: string | null
          status_changed_at?: string | null
          total_price?: number | null
          true_cost_per_unit?: number | null
          unit_price?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_parts_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_parts_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_parts_part_id_fkey"
            columns: ["part_id"]
            isOneToOne: false
            referencedRelation: "parts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_parts_source_quote_line_item_id_fkey"
            columns: ["source_quote_line_item_id"]
            isOneToOne: false
            referencedRelation: "quote_line_items"
            referencedColumns: ["id"]
          },
        ]
      }
      jobs: {
        Row: {
          bill_to_address: Json | null
          billing_address_id: string | null
          company_id: string
          completed_at: string | null
          contact_id: string | null
          contact_snapshot: Json | null
          created_at: string | null
          created_by: string | null
          customer_carrier_account_id: string | null
          customer_id: string | null
          customer_name: string | null
          customer_po_number: string | null
          deleted_at: string | null
          due_date: string | null
          freight_terms: string | null
          fulfillment_status: string
          id: string
          invoicing_status: string
          is_hot: boolean
          job_number: string
          payment_terms: string | null
          production_status: string
          quote_id: string | null
          ship_to_address: Json | null
          ship_via: string | null
          shipping_address_id: string | null
          shipping_instructions: string | null
          started_at: string | null
          status_changed_at: string | null
          updated_at: string | null
        }
        Insert: {
          bill_to_address?: Json | null
          billing_address_id?: string | null
          company_id: string
          completed_at?: string | null
          contact_id?: string | null
          contact_snapshot?: Json | null
          created_at?: string | null
          created_by?: string | null
          customer_carrier_account_id?: string | null
          customer_id?: string | null
          customer_name?: string | null
          customer_po_number?: string | null
          deleted_at?: string | null
          due_date?: string | null
          freight_terms?: string | null
          fulfillment_status: string
          id?: string
          invoicing_status?: string
          is_hot?: boolean
          job_number: string
          payment_terms?: string | null
          production_status: string
          quote_id?: string | null
          ship_to_address?: Json | null
          ship_via?: string | null
          shipping_address_id?: string | null
          shipping_instructions?: string | null
          started_at?: string | null
          status_changed_at?: string | null
          updated_at?: string | null
        }
        Update: {
          bill_to_address?: Json | null
          billing_address_id?: string | null
          company_id?: string
          completed_at?: string | null
          contact_id?: string | null
          contact_snapshot?: Json | null
          created_at?: string | null
          created_by?: string | null
          customer_carrier_account_id?: string | null
          customer_id?: string | null
          customer_name?: string | null
          customer_po_number?: string | null
          deleted_at?: string | null
          due_date?: string | null
          freight_terms?: string | null
          fulfillment_status?: string
          id?: string
          invoicing_status?: string
          is_hot?: boolean
          job_number?: string
          payment_terms?: string | null
          production_status?: string
          quote_id?: string | null
          ship_to_address?: Json | null
          ship_via?: string | null
          shipping_address_id?: string | null
          shipping_instructions?: string | null
          started_at?: string | null
          status_changed_at?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "jobs_billing_address_id_fkey"
            columns: ["billing_address_id"]
            isOneToOne: false
            referencedRelation: "customer_addresses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "customer_contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_customer_carrier_account_id_fkey"
            columns: ["customer_carrier_account_id"]
            isOneToOne: false
            referencedRelation: "customer_carrier_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "jobs_shipping_address_id_fkey"
            columns: ["shipping_address_id"]
            isOneToOne: false
            referencedRelation: "customer_addresses"
            referencedColumns: ["id"]
          },
        ]
      }
      note_media: {
        Row: {
          company_id: string
          created_at: string
          duration_seconds: number | null
          height: number | null
          id: string
          kind: string
          mime_type: string | null
          note_id: string
          size_bytes: number | null
          storage_path: string
          thumbnail_path: string | null
          width: number | null
        }
        Insert: {
          company_id: string
          created_at?: string
          duration_seconds?: number | null
          height?: number | null
          id?: string
          kind?: string
          mime_type?: string | null
          note_id: string
          size_bytes?: number | null
          storage_path: string
          thumbnail_path?: string | null
          width?: number | null
        }
        Update: {
          company_id?: string
          created_at?: string
          duration_seconds?: number | null
          height?: number | null
          id?: string
          kind?: string
          mime_type?: string | null
          note_id?: string
          size_bytes?: number | null
          storage_path?: string
          thumbnail_path?: string | null
          width?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "note_media_company_fk"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "note_media_note_fk"
            columns: ["note_id"]
            isOneToOne: false
            referencedRelation: "notes"
            referencedColumns: ["id"]
          },
        ]
      }
      note_reactions: {
        Row: {
          company_id: string
          created_at: string
          id: string
          kind: string
          note_id: string
          reactor_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          id?: string
          kind: string
          note_id: string
          reactor_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          id?: string
          kind?: string
          note_id?: string
          reactor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "note_reactions_company_fk"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "note_reactions_note_fk"
            columns: ["note_id"]
            isOneToOne: false
            referencedRelation: "notes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "note_reactions_reactor_fk"
            columns: ["reactor_id"]
            isOneToOne: false
            referencedRelation: "user_company_access"
            referencedColumns: ["id"]
          },
        ]
      }
      note_views: {
        Row: {
          company_id: string
          created_at: string
          id: string
          job_id: string | null
          note_id: string
          viewer_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          id?: string
          job_id?: string | null
          note_id: string
          viewer_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          id?: string
          job_id?: string | null
          note_id?: string
          viewer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "note_views_company_fk"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "note_views_job_fk"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "note_views_note_fk"
            columns: ["note_id"]
            isOneToOne: false
            referencedRelation: "notes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "note_views_viewer_fk"
            columns: ["viewer_id"]
            isOneToOne: false
            referencedRelation: "user_company_access"
            referencedColumns: ["id"]
          },
        ]
      }
      notes: {
        Row: {
          author_id: string | null
          body: string | null
          captured_job_id: string | null
          captured_job_operation_id: string | null
          company_id: string
          corrects_note_id: string | null
          created_at: string
          edited_at: string | null
          id: string
          job_id: string | null
          job_operation_id: string | null
          job_part_id: string | null
          maintenance_kind: string | null
          note_type: string
          part_id: string | null
          resolves_note_id: string | null
          routing_operation_id: string | null
          subject_kind: string
          usage_count: number
          viewer_count: number
          work_center_id: string | null
        }
        Insert: {
          author_id?: string | null
          body?: string | null
          captured_job_id?: string | null
          captured_job_operation_id?: string | null
          company_id: string
          corrects_note_id?: string | null
          created_at?: string
          edited_at?: string | null
          id?: string
          job_id?: string | null
          job_operation_id?: string | null
          job_part_id?: string | null
          maintenance_kind?: string | null
          note_type?: string
          part_id?: string | null
          resolves_note_id?: string | null
          routing_operation_id?: string | null
          subject_kind: string
          usage_count?: number
          viewer_count?: number
          work_center_id?: string | null
        }
        Update: {
          author_id?: string | null
          body?: string | null
          captured_job_id?: string | null
          captured_job_operation_id?: string | null
          company_id?: string
          corrects_note_id?: string | null
          created_at?: string
          edited_at?: string | null
          id?: string
          job_id?: string | null
          job_operation_id?: string | null
          job_part_id?: string | null
          maintenance_kind?: string | null
          note_type?: string
          part_id?: string | null
          resolves_note_id?: string | null
          routing_operation_id?: string | null
          subject_kind?: string
          usage_count?: number
          viewer_count?: number
          work_center_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notes_author_fk"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "user_company_access"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notes_captured_job_fk"
            columns: ["captured_job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notes_captured_job_operation_fk"
            columns: ["captured_job_operation_id"]
            isOneToOne: false
            referencedRelation: "job_operations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notes_company_fk"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notes_corrects_fk"
            columns: ["corrects_note_id"]
            isOneToOne: false
            referencedRelation: "notes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notes_job_fk"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notes_job_operation_fk"
            columns: ["job_operation_id"]
            isOneToOne: false
            referencedRelation: "job_operations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notes_job_part_fk"
            columns: ["job_part_id"]
            isOneToOne: false
            referencedRelation: "job_parts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notes_part_fk"
            columns: ["part_id"]
            isOneToOne: false
            referencedRelation: "parts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notes_resolves_fk"
            columns: ["resolves_note_id"]
            isOneToOne: false
            referencedRelation: "notes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notes_routing_operation_fk"
            columns: ["routing_operation_id"]
            isOneToOne: false
            referencedRelation: "routing_operations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "notes_work_center_fk"
            columns: ["work_center_id"]
            isOneToOne: false
            referencedRelation: "work_centers"
            referencedColumns: ["id"]
          },
        ]
      }
      operator_events: {
        Row: {
          actor_id: string | null
          company_id: string
          context: Json
          id: string
          kind: string
          occurred_at: string
        }
        Insert: {
          actor_id?: string | null
          company_id: string
          context?: Json
          id?: string
          kind: string
          occurred_at?: string
        }
        Update: {
          actor_id?: string | null
          company_id?: string
          context?: Json
          id?: string
          kind?: string
          occurred_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "operator_events_actor_fk"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "user_company_access"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operator_events_company_fk"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      operator_time_access_log: {
        Row: {
          accessed_at: string
          accessed_by: string
          company_id: string
          id: string
          reason: string
          subject_operator_id: string
        }
        Insert: {
          accessed_at?: string
          accessed_by: string
          company_id: string
          id?: string
          reason: string
          subject_operator_id: string
        }
        Update: {
          accessed_at?: string
          accessed_by?: string
          company_id?: string
          id?: string
          reason?: string
          subject_operator_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "operator_time_access_log_actor_fk"
            columns: ["accessed_by"]
            isOneToOne: false
            referencedRelation: "user_company_access"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operator_time_access_log_company_fk"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "operator_time_access_log_subject_fk"
            columns: ["subject_operator_id"]
            isOneToOne: false
            referencedRelation: "user_company_access"
            referencedColumns: ["id"]
          },
        ]
      }
      part_attachments: {
        Row: {
          company_id: string
          created_at: string
          file_name: string
          id: string
          kind: string
          mime_type: string | null
          part_id: string
          size_bytes: number | null
          storage_path: string
          uploaded_by: string | null
        }
        Insert: {
          company_id: string
          created_at?: string
          file_name: string
          id?: string
          kind?: string
          mime_type?: string | null
          part_id: string
          size_bytes?: number | null
          storage_path: string
          uploaded_by?: string | null
        }
        Update: {
          company_id?: string
          created_at?: string
          file_name?: string
          id?: string
          kind?: string
          mime_type?: string | null
          part_id?: string
          size_bytes?: number | null
          storage_path?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "part_attachments_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "part_attachments_part_id_fkey"
            columns: ["part_id"]
            isOneToOne: false
            referencedRelation: "parts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "part_attachments_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "user_company_access"
            referencedColumns: ["id"]
          },
        ]
      }
      part_comments: {
        Row: {
          author_id: string | null
          body: string
          company_id: string
          created_at: string
          edited_at: string | null
          id: string
          note_type: string
          part_id: string
        }
        Insert: {
          author_id?: string | null
          body: string
          company_id: string
          created_at?: string
          edited_at?: string | null
          id?: string
          note_type?: string
          part_id: string
        }
        Update: {
          author_id?: string | null
          body?: string
          company_id?: string
          created_at?: string
          edited_at?: string | null
          id?: string
          note_type?: string
          part_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "part_comments_author_fk"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "user_company_access"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "part_comments_company_fk"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "part_comments_part_fk"
            columns: ["part_id"]
            isOneToOne: false
            referencedRelation: "parts"
            referencedColumns: ["id"]
          },
        ]
      }
      part_location_stock: {
        Row: {
          company_id: string
          created_at: string
          id: string
          location_id: string
          part_id: string
          quantity: number
        }
        Insert: {
          company_id: string
          created_at?: string
          id?: string
          location_id: string
          part_id: string
          quantity?: number
        }
        Update: {
          company_id?: string
          created_at?: string
          id?: string
          location_id?: string
          part_id?: string
          quantity?: number
        }
        Relationships: [
          {
            foreignKeyName: "part_location_stock_company_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "part_location_stock_location_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "inventory_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "part_location_stock_part_fkey"
            columns: ["part_id"]
            isOneToOne: false
            referencedRelation: "parts"
            referencedColumns: ["id"]
          },
        ]
      }
      part_pricing_tiers: {
        Row: {
          company_id: string
          created_at: string
          id: string
          markup_percent: number | null
          part_id: string
          quantity: number
          sequence: number
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          id?: string
          markup_percent?: number | null
          part_id: string
          quantity: number
          sequence: number
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          id?: string
          markup_percent?: number | null
          part_id?: string
          quantity?: number
          sequence?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "part_pricing_tiers_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "part_pricing_tiers_part_id_fkey"
            columns: ["part_id"]
            isOneToOne: false
            referencedRelation: "parts"
            referencedColumns: ["id"]
          },
        ]
      }
      part_procurement_tiers: {
        Row: {
          cost_per_unit: number
          created_at: string
          expires_at: string | null
          id: string
          min_quantity: number
          notes: string | null
          part_id: string
          quoted_at: string | null
          updated_at: string
        }
        Insert: {
          cost_per_unit: number
          created_at?: string
          expires_at?: string | null
          id?: string
          min_quantity: number
          notes?: string | null
          part_id: string
          quoted_at?: string | null
          updated_at?: string
        }
        Update: {
          cost_per_unit?: number
          created_at?: string
          expires_at?: string | null
          id?: string
          min_quantity?: number
          notes?: string | null
          part_id?: string
          quoted_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "part_procurement_tiers_part_id_fkey"
            columns: ["part_id"]
            isOneToOne: false
            referencedRelation: "parts"
            referencedColumns: ["id"]
          },
        ]
      }
      parts: {
        Row: {
          company_id: string
          costing_batch_quantity: number
          created_at: string
          deleted_at: string | null
          description: string | null
          id: string
          is_stocked: boolean
          part_name: string
          preferred_vendor_id: string | null
          primary_unit: string | null
          quantity: number
          reorder_point: number | null
          source: string
          updated_at: string
        }
        Insert: {
          company_id: string
          costing_batch_quantity?: number
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          id?: string
          is_stocked?: boolean
          part_name: string
          preferred_vendor_id?: string | null
          primary_unit?: string | null
          quantity?: number
          reorder_point?: number | null
          source?: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          costing_batch_quantity?: number
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          id?: string
          is_stocked?: boolean
          part_name?: string
          preferred_vendor_id?: string | null
          primary_unit?: string | null
          quantity?: number
          reorder_point?: number | null
          source?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "parts_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parts_preferred_vendor_id_fkey"
            columns: ["preferred_vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      parts_bom: {
        Row: {
          charge_basis: string
          child_part_id: string
          consume_whole_units: boolean
          created_at: string
          id: string
          notes: string | null
          parent_part_id: string
          quantity: number
          sequence: number
          unit: string
          updated_at: string
        }
        Insert: {
          charge_basis?: string
          child_part_id: string
          consume_whole_units?: boolean
          created_at?: string
          id?: string
          notes?: string | null
          parent_part_id: string
          quantity: number
          sequence?: number
          unit: string
          updated_at?: string
        }
        Update: {
          charge_basis?: string
          child_part_id?: string
          consume_whole_units?: boolean
          created_at?: string
          id?: string
          notes?: string | null
          parent_part_id?: string
          quantity?: number
          sequence?: number
          unit?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "parts_bom_child_part_id_fkey"
            columns: ["child_part_id"]
            isOneToOne: false
            referencedRelation: "parts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "parts_bom_parent_part_id_fkey"
            columns: ["parent_part_id"]
            isOneToOne: false
            referencedRelation: "parts"
            referencedColumns: ["id"]
          },
        ]
      }
      parts_unit_conversions: {
        Row: {
          created_at: string
          from_unit: string
          id: string
          part_id: string
          to_primary_factor: number
        }
        Insert: {
          created_at?: string
          from_unit: string
          id?: string
          part_id: string
          to_primary_factor: number
        }
        Update: {
          created_at?: string
          from_unit?: string
          id?: string
          part_id?: string
          to_primary_factor?: number
        }
        Relationships: [
          {
            foreignKeyName: "parts_unit_conversions_part_id_fkey"
            columns: ["part_id"]
            isOneToOne: false
            referencedRelation: "parts"
            referencedColumns: ["id"]
          },
        ]
      }
      quickbooks_connections: {
        Row: {
          access_expires_at: string
          access_token: string
          company_id: string
          connected_by: string | null
          created_at: string
          default_income_account_id: string | null
          default_item_id: string | null
          environment: string
          id: string
          po_custom_field_id: string | null
          po_custom_field_name: string | null
          qb_company_name: string | null
          qb_settings_checked_at: string | null
          realm_id: string
          reconnect_required: boolean
          refresh_expires_at: string | null
          refresh_token: string
          token_version: number
          updated_at: string
        }
        Insert: {
          access_expires_at: string
          access_token: string
          company_id: string
          connected_by?: string | null
          created_at?: string
          default_income_account_id?: string | null
          default_item_id?: string | null
          environment?: string
          id?: string
          po_custom_field_id?: string | null
          po_custom_field_name?: string | null
          qb_company_name?: string | null
          qb_settings_checked_at?: string | null
          realm_id: string
          reconnect_required?: boolean
          refresh_expires_at?: string | null
          refresh_token: string
          token_version?: number
          updated_at?: string
        }
        Update: {
          access_expires_at?: string
          access_token?: string
          company_id?: string
          connected_by?: string | null
          created_at?: string
          default_income_account_id?: string | null
          default_item_id?: string | null
          environment?: string
          id?: string
          po_custom_field_id?: string | null
          po_custom_field_name?: string | null
          qb_company_name?: string | null
          qb_settings_checked_at?: string | null
          realm_id?: string
          reconnect_required?: boolean
          refresh_expires_at?: string | null
          refresh_token?: string
          token_version?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "quickbooks_connections_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: true
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quickbooks_connections_connected_by_fkey"
            columns: ["connected_by"]
            isOneToOne: false
            referencedRelation: "user_company_access"
            referencedColumns: ["id"]
          },
        ]
      }
      quickbooks_customer_map: {
        Row: {
          company_id: string
          created_at: string
          customer_id: string
          id: string
          linked_by: string | null
          provider: string
          qb_customer_id: string
          qb_display_name: string | null
          realm_id: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          customer_id: string
          id?: string
          linked_by?: string | null
          provider?: string
          qb_customer_id: string
          qb_display_name?: string | null
          realm_id: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          customer_id?: string
          id?: string
          linked_by?: string | null
          provider?: string
          qb_customer_id?: string
          qb_display_name?: string | null
          realm_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "quickbooks_customer_map_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quickbooks_customer_map_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quickbooks_customer_map_linked_by_fkey"
            columns: ["linked_by"]
            isOneToOne: false
            referencedRelation: "user_company_access"
            referencedColumns: ["id"]
          },
        ]
      }
      quickbooks_desktop_connections: {
        Row: {
          company_id: string
          conductor_end_user_id: string
          connected_by: string | null
          created_at: string
          default_income_account_id: string | null
          default_service_item_id: string | null
          environment: string
          id: string
          integration_connection_id: string | null
          last_health_check_at: string | null
          last_successful_request_at: string | null
          qb_company_name: string | null
          updated_at: string
        }
        Insert: {
          company_id: string
          conductor_end_user_id: string
          connected_by?: string | null
          created_at?: string
          default_income_account_id?: string | null
          default_service_item_id?: string | null
          environment?: string
          id?: string
          integration_connection_id?: string | null
          last_health_check_at?: string | null
          last_successful_request_at?: string | null
          qb_company_name?: string | null
          updated_at?: string
        }
        Update: {
          company_id?: string
          conductor_end_user_id?: string
          connected_by?: string | null
          created_at?: string
          default_income_account_id?: string | null
          default_service_item_id?: string | null
          environment?: string
          id?: string
          integration_connection_id?: string | null
          last_health_check_at?: string | null
          last_successful_request_at?: string | null
          qb_company_name?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "quickbooks_desktop_connections_company_fkey"
            columns: ["company_id"]
            isOneToOne: true
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quickbooks_desktop_connections_connected_by_fkey"
            columns: ["connected_by"]
            isOneToOne: false
            referencedRelation: "user_company_access"
            referencedColumns: ["id"]
          },
        ]
      }
      quickbooks_invoice_line_items: {
        Row: {
          company_id: string
          created_at: string
          id: string
          invoice_link_id: string
          job_part_id: string
          quantity: number
          total_price: number
          unit_price: number
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          id?: string
          invoice_link_id: string
          job_part_id: string
          quantity: number
          total_price: number
          unit_price: number
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          id?: string
          invoice_link_id?: string
          job_part_id?: string
          quantity?: number
          total_price?: number
          unit_price?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "qb_ili_company_fk"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "qb_ili_job_part_fk"
            columns: ["job_part_id"]
            isOneToOne: false
            referencedRelation: "job_parts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "qb_ili_link_fk"
            columns: ["invoice_link_id"]
            isOneToOne: false
            referencedRelation: "quickbooks_invoice_links"
            referencedColumns: ["id"]
          },
        ]
      }
      quickbooks_invoice_links: {
        Row: {
          company_id: string
          created_at: string
          id: string
          job_id: string
          provider: string
          pushed_by: string | null
          qb_customer_id: string | null
          qb_invoice_doc_number: string | null
          qb_invoice_id: string | null
          qb_invoice_sync_token: string | null
          qb_invoice_url: string | null
          qb_request_id: string
          quote_id: string | null
          realm_id: string
          status: string
          transaction_date: string | null
          updated_at: string
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          company_id: string
          created_at?: string
          id?: string
          job_id: string
          provider?: string
          pushed_by?: string | null
          qb_customer_id?: string | null
          qb_invoice_doc_number?: string | null
          qb_invoice_id?: string | null
          qb_invoice_sync_token?: string | null
          qb_invoice_url?: string | null
          qb_request_id: string
          quote_id?: string | null
          realm_id: string
          status?: string
          transaction_date?: string | null
          updated_at?: string
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          company_id?: string
          created_at?: string
          id?: string
          job_id?: string
          provider?: string
          pushed_by?: string | null
          qb_customer_id?: string | null
          qb_invoice_doc_number?: string | null
          qb_invoice_id?: string | null
          qb_invoice_sync_token?: string | null
          qb_invoice_url?: string | null
          qb_request_id?: string
          quote_id?: string | null
          realm_id?: string
          status?: string
          transaction_date?: string | null
          updated_at?: string
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "quickbooks_invoice_links_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quickbooks_invoice_links_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quickbooks_invoice_links_pushed_by_fkey"
            columns: ["pushed_by"]
            isOneToOne: false
            referencedRelation: "user_company_access"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quickbooks_invoice_links_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      quickbooks_terms_cache: {
        Row: {
          company_id: string
          created_at: string
          due_days: number | null
          id: string
          name: string
          provider: string
          qb_term_id: string
          realm_id: string
          refreshed_at: string
          updated_at: string
        }
        Insert: {
          company_id: string
          created_at?: string
          due_days?: number | null
          id?: string
          name: string
          provider: string
          qb_term_id: string
          realm_id: string
          refreshed_at?: string
          updated_at?: string
        }
        Update: {
          company_id?: string
          created_at?: string
          due_days?: number | null
          id?: string
          name?: string
          provider?: string
          qb_term_id?: string
          realm_id?: string
          refreshed_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "quickbooks_terms_cache_company_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      quote_line_items: {
        Row: {
          base_cost_per_unit: number | null
          basis_unknown: boolean
          company_id: string
          created_at: string
          id: string
          is_quote_override: boolean
          lead_time_text: string | null
          markup_percent: number | null
          part_id: string
          pricing_basis_snapshot: Json | null
          quantity: number
          quote_id: string
          sequence: number
          source_tier_id: string | null
          total_price: number | null
          true_cost_per_unit: number | null
          unit_price: number
        }
        Insert: {
          base_cost_per_unit?: number | null
          basis_unknown?: boolean
          company_id: string
          created_at?: string
          id?: string
          is_quote_override?: boolean
          lead_time_text?: string | null
          markup_percent?: number | null
          part_id: string
          pricing_basis_snapshot?: Json | null
          quantity: number
          quote_id: string
          sequence: number
          source_tier_id?: string | null
          total_price?: number | null
          true_cost_per_unit?: number | null
          unit_price: number
        }
        Update: {
          base_cost_per_unit?: number | null
          basis_unknown?: boolean
          company_id?: string
          created_at?: string
          id?: string
          is_quote_override?: boolean
          lead_time_text?: string | null
          markup_percent?: number | null
          part_id?: string
          pricing_basis_snapshot?: Json | null
          quantity?: number
          quote_id?: string
          sequence?: number
          source_tier_id?: string | null
          total_price?: number | null
          true_cost_per_unit?: number | null
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "quote_line_items_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_line_items_part_id_fkey"
            columns: ["part_id"]
            isOneToOne: false
            referencedRelation: "parts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_line_items_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_line_items_source_tier_id_fkey"
            columns: ["source_tier_id"]
            isOneToOne: false
            referencedRelation: "part_pricing_tiers"
            referencedColumns: ["id"]
          },
        ]
      }
      quotes: {
        Row: {
          bill_to_address: Json | null
          billing_address_id: string | null
          company_id: string
          contact_id: string | null
          contact_snapshot: Json | null
          converted_at: string | null
          created_at: string | null
          created_by: string | null
          customer_id: string | null
          customer_name: string | null
          deleted_at: string | null
          expiration_date: string | null
          id: string
          lead_time_text: string | null
          payment_terms: string | null
          quote_number: string
          ship_to_address: Json | null
          shipping_address_id: string | null
          status: string
          status_changed_at: string | null
          updated_at: string | null
        }
        Insert: {
          bill_to_address?: Json | null
          billing_address_id?: string | null
          company_id: string
          contact_id?: string | null
          contact_snapshot?: Json | null
          converted_at?: string | null
          created_at?: string | null
          created_by?: string | null
          customer_id?: string | null
          customer_name?: string | null
          deleted_at?: string | null
          expiration_date?: string | null
          id?: string
          lead_time_text?: string | null
          payment_terms?: string | null
          quote_number: string
          ship_to_address?: Json | null
          shipping_address_id?: string | null
          status?: string
          status_changed_at?: string | null
          updated_at?: string | null
        }
        Update: {
          bill_to_address?: Json | null
          billing_address_id?: string | null
          company_id?: string
          contact_id?: string | null
          contact_snapshot?: Json | null
          converted_at?: string | null
          created_at?: string | null
          created_by?: string | null
          customer_id?: string | null
          customer_name?: string | null
          deleted_at?: string | null
          expiration_date?: string | null
          id?: string
          lead_time_text?: string | null
          payment_terms?: string | null
          quote_number?: string
          ship_to_address?: Json | null
          shipping_address_id?: string | null
          status?: string
          status_changed_at?: string | null
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "quotes_billing_address_id_fkey"
            columns: ["billing_address_id"]
            isOneToOne: false
            referencedRelation: "customer_addresses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_contact_id_fkey"
            columns: ["contact_id"]
            isOneToOne: false
            referencedRelation: "customer_contacts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quotes_shipping_address_id_fkey"
            columns: ["shipping_address_id"]
            isOneToOne: false
            referencedRelation: "customer_addresses"
            referencedColumns: ["id"]
          },
        ]
      }
      routing_operations: {
        Row: {
          created_at: string | null
          cycle_minutes_per_unit: number | null
          external_unit_price: number | null
          id: string
          instructions: string | null
          labor_rate_override: number | null
          metadata: Json | null
          routing_id: string
          sequence: number
          setup_minutes: number | null
          updated_at: string | null
          work_center_id: string
        }
        Insert: {
          created_at?: string | null
          cycle_minutes_per_unit?: number | null
          external_unit_price?: number | null
          id?: string
          instructions?: string | null
          labor_rate_override?: number | null
          metadata?: Json | null
          routing_id: string
          sequence?: number
          setup_minutes?: number | null
          updated_at?: string | null
          work_center_id: string
        }
        Update: {
          created_at?: string | null
          cycle_minutes_per_unit?: number | null
          external_unit_price?: number | null
          id?: string
          instructions?: string | null
          labor_rate_override?: number | null
          metadata?: Json | null
          routing_id?: string
          sequence?: number
          setup_minutes?: number | null
          updated_at?: string | null
          work_center_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "routing_operations_routing_id_fkey"
            columns: ["routing_id"]
            isOneToOne: false
            referencedRelation: "routings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "routing_operations_work_center_id_fkey"
            columns: ["work_center_id"]
            isOneToOne: false
            referencedRelation: "work_centers"
            referencedColumns: ["id"]
          },
        ]
      }
      routings: {
        Row: {
          company_id: string
          created_at: string | null
          created_by: string | null
          description: string | null
          id: string
          name: string
          part_id: string
          updated_at: string | null
        }
        Insert: {
          company_id: string
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          id?: string
          name: string
          part_id: string
          updated_at?: string | null
        }
        Update: {
          company_id?: string
          created_at?: string | null
          created_by?: string | null
          description?: string | null
          id?: string
          name?: string
          part_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "routings_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "routings_part_id_fkey"
            columns: ["part_id"]
            isOneToOne: true
            referencedRelation: "parts"
            referencedColumns: ["id"]
          },
        ]
      }
      saved_insights: {
        Row: {
          answer: string
          chart_config: Json | null
          company_id: string
          created_at: string
          id: string
          question: string
          user_id: string
        }
        Insert: {
          answer: string
          chart_config?: Json | null
          company_id: string
          created_at?: string
          id?: string
          question: string
          user_id: string
        }
        Update: {
          answer?: string
          chart_config?: Json | null
          company_id?: string
          created_at?: string
          id?: string
          question?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "saved_insights_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      shipment_line_items: {
        Row: {
          created_at: string
          id: string
          job_part_id: string
          quantity: number
          shipment_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          job_part_id: string
          quantity: number
          shipment_id: string
        }
        Update: {
          created_at?: string
          id?: string
          job_part_id?: string
          quantity?: number
          shipment_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "shipment_line_items_job_part_id_fkey"
            columns: ["job_part_id"]
            isOneToOne: false
            referencedRelation: "job_parts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipment_line_items_shipment_id_fkey"
            columns: ["shipment_id"]
            isOneToOne: false
            referencedRelation: "shipments"
            referencedColumns: ["id"]
          },
        ]
      }
      shipments: {
        Row: {
          bill_to_address: Json | null
          carrier: string | null
          company_id: string
          created_at: string
          created_by: string | null
          customer_carrier_account_id: string | null
          customer_id: string
          customer_name: string | null
          freight_account_snapshot: Json | null
          freight_terms: string | null
          id: string
          job_id: string
          one_time_address: Json | null
          packing_slip_number: string
          ship_date: string
          ship_to_address: Json | null
          shipping_address_id: string | null
          shipping_method: string | null
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          bill_to_address?: Json | null
          carrier?: string | null
          company_id: string
          created_at?: string
          created_by?: string | null
          customer_carrier_account_id?: string | null
          customer_id: string
          customer_name?: string | null
          freight_account_snapshot?: Json | null
          freight_terms?: string | null
          id?: string
          job_id: string
          one_time_address?: Json | null
          packing_slip_number: string
          ship_date?: string
          ship_to_address?: Json | null
          shipping_address_id?: string | null
          shipping_method?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          bill_to_address?: Json | null
          carrier?: string | null
          company_id?: string
          created_at?: string
          created_by?: string | null
          customer_carrier_account_id?: string | null
          customer_id?: string
          customer_name?: string | null
          freight_account_snapshot?: Json | null
          freight_terms?: string | null
          id?: string
          job_id?: string
          one_time_address?: Json | null
          packing_slip_number?: string
          ship_date?: string
          ship_to_address?: Json | null
          shipping_address_id?: string | null
          shipping_method?: string | null
          voided_at?: string | null
          voided_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "shipments_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipments_customer_carrier_account_id_fkey"
            columns: ["customer_carrier_account_id"]
            isOneToOne: false
            referencedRelation: "customer_carrier_accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipments_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipments_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "shipments_shipping_address_id_fkey"
            columns: ["shipping_address_id"]
            isOneToOne: false
            referencedRelation: "customer_addresses"
            referencedColumns: ["id"]
          },
        ]
      }
      system_admins: {
        Row: {
          created_at: string | null
          created_by: string | null
          id: string
          user_id: string
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          id?: string
          user_id: string
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          id?: string
          user_id?: string
        }
        Relationships: []
      }
      terms_acceptances: {
        Row: {
          accepted_at: string
          accepted_via: string
          company_id: string | null
          document_sha256: string
          document_type: string
          id: string
          ip_address: unknown
          ip_source: string | null
          user_agent: string | null
          user_id: string
          version: number
        }
        Insert: {
          accepted_at?: string
          accepted_via: string
          company_id?: string | null
          document_sha256: string
          document_type: string
          id?: string
          ip_address?: unknown
          ip_source?: string | null
          user_agent?: string | null
          user_id: string
          version: number
        }
        Update: {
          accepted_at?: string
          accepted_via?: string
          company_id?: string | null
          document_sha256?: string
          document_type?: string
          id?: string
          ip_address?: unknown
          ip_source?: string | null
          user_agent?: string | null
          user_id?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "terms_acceptances_company_fk"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      user_company_access: {
        Row: {
          company_id: string
          created_at: string | null
          email: string | null
          excluded_from_metrics: boolean
          id: string
          name: string | null
          pin_hash: string | null
          reactions_seen_at: string | null
          role: string | null
          user_id: string
        }
        Insert: {
          company_id: string
          created_at?: string | null
          email?: string | null
          excluded_from_metrics?: boolean
          id?: string
          name?: string | null
          pin_hash?: string | null
          reactions_seen_at?: string | null
          role?: string | null
          user_id: string
        }
        Update: {
          company_id?: string
          created_at?: string | null
          email?: string | null
          excluded_from_metrics?: boolean
          id?: string
          name?: string | null
          pin_hash?: string | null
          reactions_seen_at?: string | null
          role?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_company_access_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      user_preferences: {
        Row: {
          created_at: string | null
          id: string
          last_company_id: string | null
          preferences: Json | null
          updated_at: string | null
          user_id: string
        }
        Insert: {
          created_at?: string | null
          id?: string
          last_company_id?: string | null
          preferences?: Json | null
          updated_at?: string | null
          user_id: string
        }
        Update: {
          created_at?: string | null
          id?: string
          last_company_id?: string | null
          preferences?: Json | null
          updated_at?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_preferences_last_company_id_fkey"
            columns: ["last_company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      vendor_contacts: {
        Row: {
          created_at: string
          email: string | null
          id: string
          is_primary: boolean
          name: string
          phone: string | null
          role: string
          role_label: string | null
          updated_at: string
          vendor_id: string
        }
        Insert: {
          created_at?: string
          email?: string | null
          id?: string
          is_primary?: boolean
          name: string
          phone?: string | null
          role: string
          role_label?: string | null
          updated_at?: string
          vendor_id: string
        }
        Update: {
          created_at?: string
          email?: string | null
          id?: string
          is_primary?: boolean
          name?: string
          phone?: string | null
          role?: string
          role_label?: string | null
          updated_at?: string
          vendor_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "vendor_contacts_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
      vendors: {
        Row: {
          address_line1: string | null
          address_line2: string | null
          city: string | null
          company_id: string
          country: string | null
          created_at: string
          deleted_at: string | null
          id: string
          name: string
          postal_code: string | null
          state: string | null
          updated_at: string
        }
        Insert: {
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          company_id: string
          country?: string | null
          created_at?: string
          deleted_at?: string | null
          id?: string
          name: string
          postal_code?: string | null
          state?: string | null
          updated_at?: string
        }
        Update: {
          address_line1?: string | null
          address_line2?: string | null
          city?: string | null
          company_id?: string
          country?: string | null
          created_at?: string
          deleted_at?: string | null
          id?: string
          name?: string
          postal_code?: string | null
          state?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "vendors_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      waitlist: {
        Row: {
          company_name: string | null
          created_at: string | null
          email: string
          id: string
          name: string | null
          shop_size: string | null
          source: string | null
          status: string
        }
        Insert: {
          company_name?: string | null
          created_at?: string | null
          email: string
          id?: string
          name?: string | null
          shop_size?: string | null
          source?: string | null
          status?: string
        }
        Update: {
          company_name?: string | null
          created_at?: string | null
          email?: string
          id?: string
          name?: string | null
          shop_size?: string | null
          source?: string | null
          status?: string
        }
        Relationships: []
      }
      work_center_attachments: {
        Row: {
          company_id: string
          created_at: string
          file_name: string
          id: string
          kind: string
          mime_type: string | null
          size_bytes: number | null
          storage_path: string
          uploaded_by: string | null
          work_center_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          file_name: string
          id?: string
          kind?: string
          mime_type?: string | null
          size_bytes?: number | null
          storage_path: string
          uploaded_by?: string | null
          work_center_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          file_name?: string
          id?: string
          kind?: string
          mime_type?: string | null
          size_bytes?: number | null
          storage_path?: string
          uploaded_by?: string | null
          work_center_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "work_center_attachments_company_fk"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_center_attachments_uploader_fk"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "user_company_access"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_center_attachments_wc_fk"
            columns: ["work_center_id"]
            isOneToOne: false
            referencedRelation: "work_centers"
            referencedColumns: ["id"]
          },
        ]
      }
      work_centers: {
        Row: {
          company_id: string
          created_at: string
          deleted_at: string | null
          description: string | null
          id: string
          kind: string
          labor_rate: number | null
          make: string | null
          metadata: Json | null
          model: string | null
          name: string
          purchased_on: string | null
          serial_number: string | null
          updated_at: string
          vendor_id: string | null
          year_built: number | null
        }
        Insert: {
          company_id: string
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          id?: string
          kind?: string
          labor_rate?: number | null
          make?: string | null
          metadata?: Json | null
          model?: string | null
          name: string
          purchased_on?: string | null
          serial_number?: string | null
          updated_at?: string
          vendor_id?: string | null
          year_built?: number | null
        }
        Update: {
          company_id?: string
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          id?: string
          kind?: string
          labor_rate?: number | null
          make?: string | null
          metadata?: Json | null
          model?: string | null
          name?: string
          purchased_on?: string | null
          serial_number?: string | null
          updated_at?: string
          vendor_id?: string | null
          year_built?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "work_centers_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "work_centers_vendor_id_fkey"
            columns: ["vendor_id"]
            isOneToOne: false
            referencedRelation: "vendors"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      inventory_location_occupancy: {
        Row: {
          company_id: string | null
          location_id: string | null
          part_count: number | null
        }
        Relationships: [
          {
            foreignKeyName: "part_location_stock_company_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "part_location_stock_location_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "inventory_locations"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      _migrate_legacy_shipment_for_job: {
        Args: { p_job_id: string }
        Returns: string
      }
      accept_invitation: {
        Args: { p_invitation_id: string; p_user_id: string }
        Returns: string
      }
      add_stock_at_location: {
        Args: {
          p_converted_quantity: number
          p_location_id: string
          p_notes?: string
          p_operator_id?: string
          p_part_id: string
          p_photo_path?: string
          p_quantity: number
          p_unit: string
        }
        Returns: Json
      }
      address_block_snapshot: { Args: { p_address_id: string }; Returns: Json }
      adjust_stock_at_location: {
        Args: {
          p_converted_new_quantity: number
          p_location_id: string
          p_new_quantity: number
          p_notes?: string
          p_operator_id?: string
          p_part_id: string
          p_unit: string
        }
        Returns: Json
      }
      apply_billing_write_gate: {
        Args: { p_table: unknown }
        Returns: undefined
      }
      apply_location_layout: {
        Args: {
          p_moves?: Json
          p_nodes: Json
          p_parent_id: string
          p_removals?: string[]
        }
        Returns: {
          company_id: string
          created_at: string
          id: string
          kind: string | null
          name: string
          parent_id: string | null
          sort_order: number
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "inventory_locations"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      apply_stripe_subscription: {
        Args: {
          p_cancel_at: string
          p_canceled_at: string
          p_company_id: string
          p_current_period_end: string
          p_ended_at: string
          p_event_at: string
          p_price_id: string
          p_status: string
          p_stripe_customer_id: string
          p_stripe_subscription_id: string
          p_trial_end: string
        }
        Returns: undefined
      }
      archive_parts: { Args: { p_ids: string[] }; Returns: undefined }
      bulk_put_away: {
        Args: {
          p_from_location_id: string
          p_part_ids: string[]
          p_to_location_id: string
        }
        Returns: Json
      }
      close_operation_interval: {
        Args: {
          p_adjusted_ended_at?: string
          p_adjusted_started_at?: string
          p_completion_id?: string
          p_interval_id: string
          p_note?: string
        }
        Returns: undefined
      }
      company_can_write: {
        Args: { check_company_id: string }
        Returns: boolean
      }
      compute_job_fulfillment_status: {
        Args: { p_job_id: string }
        Returns: string
      }
      compute_job_invoicing_status: {
        Args: { p_job_id: string }
        Returns: string
      }
      compute_job_operation_status: {
        Args: { p_job_operation_id: string }
        Returns: string
      }
      compute_job_part_fulfillment_status: {
        Args: { p_job_part_id: string }
        Returns: string
      }
      compute_job_part_invoicing_status: {
        Args: { p_job_part_id: string }
        Returns: string
      }
      compute_job_part_production_status: {
        Args: { p_job_part_id: string }
        Returns: string
      }
      compute_job_production_status: {
        Args: { p_job_id: string }
        Returns: string
      }
      compute_part_charge_base_at_qty: {
        Args: { p_part_id: string; p_qty: number }
        Returns: number
      }
      compute_part_cost_at_qty: {
        Args: { p_part_id: string; p_qty: number }
        Returns: number
      }
      compute_part_cost_explain: {
        Args: { p_part_id: string; p_qty: number }
        Returns: {
          is_priceable: boolean
          missing_leaves: Json
          missing_markups: Json
          missing_op_rates: Json
          unit_cost: number
        }[]
      }
      compute_part_price_at_qty: {
        Args: { p_part_id: string; p_qty: number }
        Returns: number
      }
      compute_part_price_explain_at_qty: {
        Args: { p_part_id: string; p_qty: number }
        Returns: {
          markup_percent: number
          unit_price: number
        }[]
      }
      contact_block_snapshot: { Args: { p_contact_id: string }; Returns: Json }
      create_demo_company: {
        Args: {
          p_source_company_id: string
          p_template_name?: string
          p_user_id: string
        }
        Returns: string
      }
      create_job_part_operations_from_routing: {
        Args: { p_job_part_id: string; p_routing_id: string }
        Returns: number
      }
      create_location_tree: {
        Args: { p_company_id: string; p_nodes: Json; p_parent_id?: string }
        Returns: {
          company_id: string
          created_at: string
          id: string
          kind: string | null
          name: string
          parent_id: string | null
          sort_order: number
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "inventory_locations"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      create_shipment_with_line_items: {
        Args: {
          p_carrier: string
          p_company_id: string
          p_customer_carrier_account_id?: string
          p_customer_id: string
          p_freight_terms?: string
          p_line_items: Json
          p_notes?: string
          p_one_time_address: Json
          p_ship_date: string
          p_shipping_address_id: string
          p_shipping_method: string
        }
        Returns: string
      }
      definer_writers_missing_write_gate: {
        Args: never
        Returns: {
          function_name: string
        }[]
      }
      delete_location: { Args: { p_location_id: string }; Returns: undefined }
      deplete_stock_at_location: {
        Args: {
          p_converted_quantity: number
          p_graceful?: boolean
          p_job_id?: string
          p_job_operation_id?: string
          p_location_id: string
          p_notes?: string
          p_operator_id?: string
          p_part_id: string
          p_quantity: number
          p_unit: string
        }
        Returns: Json
      }
      function_execute_leaks: {
        Args: never
        Returns: {
          function_name: string
          role_name: string
        }[]
      }
      generate_direct_job_number: {
        Args: { company_uuid: string }
        Returns: string
      }
      generate_quote_number: { Args: { company_uuid: string }; Returns: string }
      get_open_intervals: {
        Args: { p_company_id: string }
        Returns: {
          capture_source: string
          interval_id: string
          job_id: string
          job_number: string
          job_operation_id: string
          operation_name: string
          part_name: string
          started_at: string
          work_center_name: string
        }[]
      }
      get_operation_actuals: {
        Args: { p_job_operation_ids: string[] }
        Returns: {
          actual_minutes: number
          adjusted_count: number
          first_started_at: string
          interval_count: number
          job_operation_id: string
          last_ended_at: string
          open_count: number
        }[]
      }
      get_operator_access_id: {
        Args: { check_company_id: string }
        Returns: string
      }
      get_operator_time_detail: {
        Args: { p_company_id: string; p_operator_id: string; p_reason: string }
        Returns: {
          adjusted_at: string
          close_reason: string
          effective_ended_at: string
          effective_started_at: string
          ended_at: string
          interval_id: string
          job_number: string
          job_operation_id: string
          operation_name: string
          started_at: string
        }[]
      }
      get_priceable_part_ids: {
        Args: { p_company_id: string }
        Returns: string[]
      }
      get_procurement_cost: {
        Args: { p_part_id: string; p_qty: number }
        Returns: {
          source: string
          tier_id: string
          unit_cost: number
          vendor_id: string
        }[]
      }
      get_ready_operations_batch: {
        Args: { p_job_ids: string[] }
        Returns: {
          job_id: string
          operation_name: string
          ready_count: number
        }[]
      }
      get_ready_operations_for_station: {
        Args: { p_company_id: string; p_work_center_id: string }
        Returns: {
          is_hot: boolean
          job_id: string
          job_number: string
          job_operation_id: string
          job_part_id: string
          op_status: string
          operation_name: string
          part_description: string
          part_id: string
          part_name: string
          part_quantity: number
        }[]
      }
      get_user_company_ids: { Args: never; Returns: string[] }
      inv_assert_can_write: {
        Args: { p_company_id: string }
        Returns: undefined
      }
      inv_assert_location_in_company: {
        Args: { p_company_id: string; p_location_id: string }
        Returns: undefined
      }
      inv_get_or_create_unassigned: {
        Args: { p_company_id: string }
        Returns: string
      }
      inv_location_path_label: {
        Args: { p_location_id: string }
        Returns: string
      }
      is_company_admin: { Args: { check_company_id: string }; Returns: boolean }
      is_system_admin: { Args: { check_user_id: string }; Returns: boolean }
      job_last_ship_date: { Args: { p_job_id: string }; Returns: string }
      job_part_last_ship_date: {
        Args: { p_job_part_id: string }
        Returns: string
      }
      log_note_views: {
        Args: { p_job_id?: string; p_note_ids: string[] }
        Returns: undefined
      }
      log_operator_event: {
        Args: { p_company_id: string; p_context?: Json; p_kind: string }
        Returns: undefined
      }
      mark_reactions_seen: {
        Args: { p_company_id: string; p_seen_through: string }
        Returns: undefined
      }
      my_note_digest: {
        Args: never
        Returns: {
          helpful: number
          views: number
        }[]
      }
      next_order_number: { Args: { company_uuid: string }; Returns: number }
      no_client_access_grant_leaks: {
        Args: never
        Returns: {
          grantee: string
          privilege_type: string
          table_name: string
        }[]
      }
      note_count_anomalies: {
        Args: never
        Returns: {
          live_usage: number
          live_viewers: number
          note_id: string
          stored_usage: number
          stored_viewers: number
        }[]
      }
      note_counter_write_leaks: {
        Args: never
        Returns: {
          column_name: string
          role_name: string
        }[]
      }
      note_viewers: {
        Args: { p_note_id: string }
        Returns: {
          job_number: string
          viewer_name: string
        }[]
      }
      part_playbook_notes: {
        Args: {
          p_exclude_job_id?: string
          p_max_runs?: number
          p_operation_name?: string
          p_part_id: string
          p_routing_operation_id?: string
        }
        Returns: {
          author_id: string
          author_name: string
          body: string
          corrects_note_id: string
          created_at: string
          edited_at: string
          id: string
          job_number: string
          media: Json
          note_type: string
          operation_label: string
          reactions: Json
          routing_operation_id: string
          subject_kind: string
          usage_count: number
          viewer_count: number
        }[]
      }
      part_rollup_at_qty: {
        Args: {
          p_apply_charge_basis: boolean
          p_part_id: string
          p_qty: number
        }
        Returns: number
      }
      parts_deletion_impact: {
        Args: { p_ids: string[] }
        Returns: {
          bom_parents_count: number
          jobs_count: number
          quotes_count: number
        }[]
      }
      playbook_rpc_execute_leaks: {
        Args: never
        Returns: {
          role_name: string
        }[]
      }
      reset_demo_company: {
        Args: { p_source_company_id: string; p_user_id: string }
        Returns: undefined
      }
      search_jobs_by_identifier: {
        Args: {
          p_company_id: string
          p_customer_id?: string
          p_limit?: number
          p_overdue?: boolean
          p_query: string
          p_stage_pairs?: string[]
          p_today?: string
        }
        Returns: {
          job_id: string
          match_source: string
          total_matches: number
        }[]
      }
      seed_demo_data: {
        Args: {
          p_company_id: string
          p_template_name?: string
          p_user_id: string
        }
        Returns: undefined
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
      start_operation_interval: {
        Args: { p_job_operation_id: string }
        Returns: {
          interval_id: string
          server_now: string
          started_at: string
        }[]
      }
      sync_demo_access: {
        Args: { p_demo_company_id: string; p_source_company_id: string }
        Returns: undefined
      }
      sync_demo_features: {
        Args: { p_demo_company_id: string; p_source_company_id: string }
        Returns: undefined
      }
      tenant_tables_missing_write_gate: {
        Args: never
        Returns: {
          table_name: string
        }[]
      }
      tenant_tables_with_silent_update_gate: {
        Args: never
        Returns: {
          table_name: string
        }[]
      }
      terms_acceptance_write_leaks: {
        Args: never
        Returns: {
          detail: string
          leak_kind: string
        }[]
      }
      transfer_stock: {
        Args: {
          p_converted_quantity: number
          p_from_location_id: string
          p_notes?: string
          p_operator_id?: string
          p_part_id: string
          p_photo_path?: string
          p_quantity: number
          p_to_location_id: string
          p_unit: string
        }
        Returns: Json
      }
      viewer_excluded_from_metrics: {
        Args: { p_access_id: string }
        Returns: boolean
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {},
  },
} as const

