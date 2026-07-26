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
      customer_contacts: {
        Row: {
          created_at: string
          customer_id: string
          email: string | null
          id: string
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
          email?: string | null
          id?: string
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
          email?: string | null
          id?: string
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
          deleted_at: string | null
          id: string
          name: string
          updated_at: string | null
          website: string | null
        }
        Insert: {
          company_id: string
          created_at?: string | null
          deleted_at?: string | null
          id?: string
          name: string
          updated_at?: string | null
          website?: string | null
        }
        Update: {
          company_id?: string
          created_at?: string | null
          deleted_at?: string | null
          id?: string
          name?: string
          updated_at?: string | null
          website?: string | null
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
          code: string | null
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
          code?: string | null
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
          code?: string | null
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
      job_note_media: {
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
            foreignKeyName: "job_note_media_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_note_media_note_id_fkey"
            columns: ["note_id"]
            isOneToOne: false
            referencedRelation: "job_notes"
            referencedColumns: ["id"]
          },
        ]
      }
      job_notes: {
        Row: {
          author_id: string | null
          body: string | null
          company_id: string
          created_at: string
          id: string
          job_id: string
          job_operation_id: string | null
          job_part_id: string | null
          note_type: string
        }
        Insert: {
          author_id?: string | null
          body?: string | null
          company_id: string
          created_at?: string
          id?: string
          job_id: string
          job_operation_id?: string | null
          job_part_id?: string | null
          note_type?: string
        }
        Update: {
          author_id?: string | null
          body?: string | null
          company_id?: string
          created_at?: string
          id?: string
          job_id?: string
          job_operation_id?: string | null
          job_part_id?: string | null
          note_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "job_notes_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "user_company_access"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_notes_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_notes_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_notes_job_operation_id_fkey"
            columns: ["job_operation_id"]
            isOneToOne: false
            referencedRelation: "job_operations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "job_notes_job_part_id_fkey"
            columns: ["job_part_id"]
            isOneToOne: false
            referencedRelation: "job_parts"
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
      job_operations: {
        Row: {
          completed_at: string | null
          completed_by: string | null
          created_at: string | null
          estimated_run_minutes_per_unit: number | null
          estimated_setup_minutes: number | null
          id: string
          instructions: string | null
          job_id: string
          job_part_id: string
          notes: string | null
          operation_name: string
          routing_operation_id: string | null
          sent_at: string | null
          sent_by: string | null
          sequence: number
          status: string
          updated_at: string | null
          work_center_id: string | null
        }
        Insert: {
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string | null
          estimated_run_minutes_per_unit?: number | null
          estimated_setup_minutes?: number | null
          id?: string
          instructions?: string | null
          job_id: string
          job_part_id: string
          notes?: string | null
          operation_name: string
          routing_operation_id?: string | null
          sent_at?: string | null
          sent_by?: string | null
          sequence: number
          status?: string
          updated_at?: string | null
          work_center_id?: string | null
        }
        Update: {
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string | null
          estimated_run_minutes_per_unit?: number | null
          estimated_setup_minutes?: number | null
          id?: string
          instructions?: string | null
          job_id?: string
          job_part_id?: string
          notes?: string | null
          operation_name?: string
          routing_operation_id?: string | null
          sent_at?: string | null
          sent_by?: string | null
          sequence?: number
          status?: string
          updated_at?: string | null
          work_center_id?: string | null
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
          customer_id: string | null
          customer_name: string | null
          customer_po_number: string | null
          deleted_at: string | null
          due_date: string | null
          fulfillment_status: string
          id: string
          invoicing_status: string
          is_hot: boolean
          job_number: string
          production_status: string
          quote_id: string | null
          ship_to_address: Json | null
          shipping_address_id: string | null
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
          customer_id?: string | null
          customer_name?: string | null
          customer_po_number?: string | null
          deleted_at?: string | null
          due_date?: string | null
          fulfillment_status: string
          id?: string
          invoicing_status?: string
          is_hot?: boolean
          job_number: string
          production_status: string
          quote_id?: string | null
          ship_to_address?: Json | null
          shipping_address_id?: string | null
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
          customer_id?: string | null
          customer_name?: string | null
          customer_po_number?: string | null
          deleted_at?: string | null
          due_date?: string | null
          fulfillment_status?: string
          id?: string
          invoicing_status?: string
          is_hot?: boolean
          job_number?: string
          production_status?: string
          quote_id?: string | null
          ship_to_address?: Json | null
          shipping_address_id?: string | null
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
      part_notes: {
        Row: {
          author_id: string | null
          body: string
          company_id: string
          created_at: string
          id: string
          note_type: string
          part_id: string
        }
        Insert: {
          author_id?: string | null
          body: string
          company_id: string
          created_at?: string
          id?: string
          note_type?: string
          part_id: string
        }
        Update: {
          author_id?: string | null
          body?: string
          company_id?: string
          created_at?: string
          id?: string
          note_type?: string
          part_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "part_notes_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "user_company_access"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "part_notes_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "part_notes_part_id_fkey"
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
          is_location_tracked: boolean
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
          is_location_tracked?: boolean
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
          is_location_tracked?: boolean
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
          qb_company_name: string | null
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
          qb_company_name?: string | null
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
          qb_company_name?: string | null
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
          pushed_by: string | null
          qb_invoice_doc_number: string | null
          qb_invoice_id: string | null
          qb_invoice_sync_token: string | null
          qb_invoice_url: string | null
          qb_request_id: string
          quote_id: string | null
          realm_id: string
          status: string
          updated_at: string
          voided_at: string | null
          voided_by: string | null
        }
        Insert: {
          company_id: string
          created_at?: string
          id?: string
          job_id: string
          pushed_by?: string | null
          qb_invoice_doc_number?: string | null
          qb_invoice_id?: string | null
          qb_invoice_sync_token?: string | null
          qb_invoice_url?: string | null
          qb_request_id: string
          quote_id?: string | null
          realm_id: string
          status?: string
          updated_at?: string
          voided_at?: string | null
          voided_by?: string | null
        }
        Update: {
          company_id?: string
          created_at?: string
          id?: string
          job_id?: string
          pushed_by?: string | null
          qb_invoice_doc_number?: string | null
          qb_invoice_id?: string | null
          qb_invoice_sync_token?: string | null
          qb_invoice_url?: string | null
          qb_request_id?: string
          quote_id?: string | null
          realm_id?: string
          status?: string
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
      quote_materials: {
        Row: {
          company_id: string
          cost_per_unit: number | null
          created_at: string
          id: string
          item_name: string
          line_cost: number | null
          material_part_id: string | null
          part_id: string
          quantity: number
          quote_id: string
          sequence: number
          unit: string | null
          units_consumed: number | null
        }
        Insert: {
          company_id: string
          cost_per_unit?: number | null
          created_at?: string
          id?: string
          item_name: string
          line_cost?: number | null
          material_part_id?: string | null
          part_id: string
          quantity: number
          quote_id: string
          sequence: number
          unit?: string | null
          units_consumed?: number | null
        }
        Update: {
          company_id?: string
          cost_per_unit?: number | null
          created_at?: string
          id?: string
          item_name?: string
          line_cost?: number | null
          material_part_id?: string | null
          part_id?: string
          quantity?: number
          quote_id?: string
          sequence?: number
          unit?: string | null
          units_consumed?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "quote_materials_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_materials_material_part_id_fkey"
            columns: ["material_part_id"]
            isOneToOne: false
            referencedRelation: "parts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_materials_part_id_fkey"
            columns: ["part_id"]
            isOneToOne: false
            referencedRelation: "parts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_materials_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
            referencedColumns: ["id"]
          },
        ]
      }
      quote_operations: {
        Row: {
          company_id: string
          created_at: string
          id: string
          labor_rate: number | null
          operation_name: string
          part_id: string
          quote_id: string
          run_cost: number | null
          run_time_minutes: number | null
          sequence: number
          setup_cost: number | null
          setup_time_minutes: number | null
        }
        Insert: {
          company_id: string
          created_at?: string
          id?: string
          labor_rate?: number | null
          operation_name: string
          part_id: string
          quote_id: string
          run_cost?: number | null
          run_time_minutes?: number | null
          sequence: number
          setup_cost?: number | null
          setup_time_minutes?: number | null
        }
        Update: {
          company_id?: string
          created_at?: string
          id?: string
          labor_rate?: number | null
          operation_name?: string
          part_id?: string
          quote_id?: string
          run_cost?: number | null
          run_time_minutes?: number | null
          sequence?: number
          setup_cost?: number | null
          setup_time_minutes?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "quote_operations_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_operations_part_id_fkey"
            columns: ["part_id"]
            isOneToOne: false
            referencedRelation: "parts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "quote_operations_quote_id_fkey"
            columns: ["quote_id"]
            isOneToOne: false
            referencedRelation: "quotes"
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
          customer_id: string
          customer_name: string | null
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
          customer_id: string
          customer_name?: string | null
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
          customer_id?: string
          customer_name?: string | null
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
      user_company_access: {
        Row: {
          company_id: string
          created_at: string | null
          email: string | null
          id: string
          name: string | null
          pin_hash: string | null
          role: string | null
          user_id: string
        }
        Insert: {
          company_id: string
          created_at?: string | null
          email?: string | null
          id?: string
          name?: string | null
          pin_hash?: string | null
          role?: string | null
          user_id: string
        }
        Update: {
          company_id?: string
          created_at?: string | null
          email?: string | null
          id?: string
          name?: string | null
          pin_hash?: string | null
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
      work_centers: {
        Row: {
          company_id: string
          created_at: string
          deleted_at: string | null
          description: string | null
          id: string
          kind: string
          labor_rate: number | null
          metadata: Json | null
          name: string
          updated_at: string
          vendor_id: string | null
        }
        Insert: {
          company_id: string
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          id?: string
          kind?: string
          labor_rate?: number | null
          metadata?: Json | null
          name: string
          updated_at?: string
          vendor_id?: string | null
        }
        Update: {
          company_id?: string
          created_at?: string
          deleted_at?: string | null
          description?: string | null
          id?: string
          kind?: string
          labor_rate?: number | null
          metadata?: Json | null
          name?: string
          updated_at?: string
          vendor_id?: string | null
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
      [_ in never]: never
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
          p_part_id: string
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
          p_part_id: string
          p_unit: string
        }
        Returns: Json
      }
      apply_billing_write_gate: {
        Args: { p_table: unknown }
        Returns: undefined
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
      create_shipment_with_line_items: {
        Args: {
          p_carrier: string
          p_company_id: string
          p_customer_id: string
          p_line_items: Json
          p_notes?: string
          p_one_time_address: Json
          p_ship_date: string
          p_shipping_address_id: string
          p_shipping_method: string
        }
        Returns: string
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
      disable_location_tracking: { Args: { p_part_id: string }; Returns: Json }
      enable_location_tracking: {
        Args: { p_initial_location_id?: string; p_part_id: string }
        Returns: Json
      }
      enable_location_tracking_for_company: {
        Args: { p_company_id: string }
        Returns: Json
      }
      generate_direct_job_number: {
        Args: { company_uuid: string }
        Returns: string
      }
      generate_quote_number: { Args: { company_uuid: string }; Returns: string }
      get_operator_access_id: {
        Args: { check_company_id: string }
        Returns: string
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
      next_order_number: { Args: { company_uuid: string }; Returns: number }
      parts_deletion_impact: {
        Args: { p_ids: string[] }
        Returns: {
          bom_parents_count: number
          jobs_count: number
          quotes_count: number
        }[]
      }
      reset_demo_company: {
        Args: { p_source_company_id: string; p_user_id: string }
        Returns: undefined
      }
      search_jobs_by_identifier: {
        Args: { p_company_id: string; p_query: string }
        Returns: {
          job_id: string
          match_source: string
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
      sync_demo_access: {
        Args: { p_demo_company_id: string; p_source_company_id: string }
        Returns: undefined
      }
      tenant_tables_missing_write_gate: {
        Args: never
        Returns: {
          table_name: string
        }[]
      }
      transfer_stock: {
        Args: {
          p_converted_quantity: number
          p_from_location_id: string
          p_notes?: string
          p_part_id: string
          p_quantity: number
          p_to_location_id: string
          p_unit: string
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

