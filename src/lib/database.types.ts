// Based on Supabase CLI output, extended for the reviewed local migrations.

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Tables: {
      activities: {
        Row: {
          company_id: string;
          contact_id: string | null;
          content: string | null;
          created_at: string;
          id: string;
          request_id: string | null;
          request_payload: Json | null;
          occurred_at: string;
          organization_id: string;
          title: string | null;
          type: string;
          user_id: string;
        };
        Insert: {
          company_id: string;
          contact_id?: string | null;
          content?: string | null;
          created_at?: string;
          id?: string;
          request_id?: string | null;
          request_payload?: Json | null;
          occurred_at?: string;
          organization_id: string;
          title?: string | null;
          type: string;
          user_id: string;
        };
        Update: {
          company_id?: string;
          contact_id?: string | null;
          content?: string | null;
          created_at?: string;
          id?: string;
          request_id?: string | null;
          request_payload?: Json | null;
          occurred_at?: string;
          organization_id?: string;
          title?: string | null;
          type?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "activities_organization_id_company_id_contact_id_fkey";
            columns: ["organization_id", "company_id", "contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["organization_id", "company_id", "id"];
          },
          {
            foreignKeyName: "activities_organization_id_company_id_fkey";
            columns: ["organization_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "activities_organization_id_company_id_fkey";
            columns: ["organization_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "company_overview";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "activities_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "activities_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      business_processes: {
        Row: {
          company_id: string;
          created_at: string;
          current_method: string | null;
          description: string | null;
          id: string;
          notes: string | null;
          organization_id: string;
          pain_level: number | null;
          process_type: string;
          updated_at: string;
        };
        Insert: {
          company_id: string;
          created_at?: string;
          current_method?: string | null;
          description?: string | null;
          id?: string;
          notes?: string | null;
          organization_id: string;
          pain_level?: number | null;
          process_type: string;
          updated_at?: string;
        };
        Update: {
          company_id?: string;
          created_at?: string;
          current_method?: string | null;
          description?: string | null;
          id?: string;
          notes?: string | null;
          organization_id?: string;
          pain_level?: number | null;
          process_type?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "business_processes_organization_id_company_id_fkey";
            columns: ["organization_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "business_processes_organization_id_company_id_fkey";
            columns: ["organization_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "company_overview";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "business_processes_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      call_details: {
        Row: {
          activity_id: string;
          duration_seconds: number | null;
          ended_at: string | null;
          phone_number: string | null;
          result: string | null;
          started_at: string | null;
          zoom_call_id: string | null;
        };
        Insert: {
          activity_id: string;
          duration_seconds?: number | null;
          ended_at?: string | null;
          phone_number?: string | null;
          result?: string | null;
          started_at?: string | null;
          zoom_call_id?: string | null;
        };
        Update: {
          activity_id?: string;
          duration_seconds?: number | null;
          ended_at?: string | null;
          phone_number?: string | null;
          result?: string | null;
          started_at?: string | null;
          zoom_call_id?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "call_details_activity_id_fkey";
            columns: ["activity_id"];
            isOneToOne: true;
            referencedRelation: "activities";
            referencedColumns: ["id"];
          },
        ];
      };
      companies: {
        Row: {
          address: string | null;
          assigned_user_id: string | null;
          business_description: string | null;
          capital: number | null;
          city: string | null;
          company_status: string;
          contact_url: string | null;
          corporate_number: string | null;
          created_at: string;
          employee_max: number | null;
          employee_min: number | null;
          id: string;
          industry: string | null;
          industry_subcategory: string | null;
          name: string;
          organization_id: string;
          phone: string | null;
          prefecture: string | null;
          source: string | null;
          updated_at: string;
          website_url: string | null;
        };
        Insert: {
          address?: string | null;
          assigned_user_id?: string | null;
          business_description?: string | null;
          capital?: number | null;
          city?: string | null;
          company_status?: string;
          contact_url?: string | null;
          corporate_number?: string | null;
          created_at?: string;
          employee_max?: number | null;
          employee_min?: number | null;
          id?: string;
          industry?: string | null;
          industry_subcategory?: string | null;
          name: string;
          organization_id: string;
          phone?: string | null;
          prefecture?: string | null;
          source?: string | null;
          updated_at?: string;
          website_url?: string | null;
        };
        Update: {
          address?: string | null;
          assigned_user_id?: string | null;
          business_description?: string | null;
          capital?: number | null;
          city?: string | null;
          company_status?: string;
          contact_url?: string | null;
          corporate_number?: string | null;
          created_at?: string;
          employee_max?: number | null;
          employee_min?: number | null;
          id?: string;
          industry?: string | null;
          industry_subcategory?: string | null;
          name?: string;
          organization_id?: string;
          phone?: string | null;
          prefecture?: string | null;
          source?: string | null;
          updated_at?: string;
          website_url?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "companies_organization_id_assigned_user_id_fkey";
            columns: ["organization_id", "assigned_user_id"];
            isOneToOne: false;
            referencedRelation: "organization_members";
            referencedColumns: ["organization_id", "user_id"];
          },
          {
            foreignKeyName: "companies_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      company_tools: {
        Row: {
          category: string | null;
          company_id: string;
          created_at: string;
          id: string;
          keep_or_replace: string;
          organization_id: string;
          tool_name: string;
          updated_at: string;
          usage_description: string | null;
        };
        Insert: {
          category?: string | null;
          company_id: string;
          created_at?: string;
          id?: string;
          keep_or_replace?: string;
          organization_id: string;
          tool_name: string;
          updated_at?: string;
          usage_description?: string | null;
        };
        Update: {
          category?: string | null;
          company_id?: string;
          created_at?: string;
          id?: string;
          keep_or_replace?: string;
          organization_id?: string;
          tool_name?: string;
          updated_at?: string;
          usage_description?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "company_tools_organization_id_company_id_fkey";
            columns: ["organization_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "company_tools_organization_id_company_id_fkey";
            columns: ["organization_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "company_overview";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "company_tools_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      contacts: {
        Row: {
          company_id: string;
          created_at: string;
          department: string | null;
          email: string | null;
          id: string;
          is_decision_maker: boolean;
          name: string;
          notes: string | null;
          organization_id: string;
          phone: string | null;
          position: string | null;
          updated_at: string;
        };
        Insert: {
          company_id: string;
          created_at?: string;
          department?: string | null;
          email?: string | null;
          id?: string;
          is_decision_maker?: boolean;
          name: string;
          notes?: string | null;
          organization_id: string;
          phone?: string | null;
          position?: string | null;
          updated_at?: string;
        };
        Update: {
          company_id?: string;
          created_at?: string;
          department?: string | null;
          email?: string | null;
          id?: string;
          is_decision_maker?: boolean;
          name?: string;
          notes?: string | null;
          organization_id?: string;
          phone?: string | null;
          position?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "contacts_organization_id_company_id_fkey";
            columns: ["organization_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "contacts_organization_id_company_id_fkey";
            columns: ["organization_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "company_overview";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "contacts_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      deals: {
        Row: {
          company_id: string;
          contact_id: string | null;
          created_at: string;
          expected_close_date: string | null;
          id: string;
          initial_price: number | null;
          lost_reason: string | null;
          monthly_price: number | null;
          name: string;
          notes: string | null;
          organization_id: string;
          owner_user_id: string;
          stage: string;
          updated_at: string;
        };
        Insert: {
          company_id: string;
          contact_id?: string | null;
          created_at?: string;
          expected_close_date?: string | null;
          id?: string;
          initial_price?: number | null;
          lost_reason?: string | null;
          monthly_price?: number | null;
          name: string;
          notes?: string | null;
          organization_id: string;
          owner_user_id: string;
          stage?: string;
          updated_at?: string;
        };
        Update: {
          company_id?: string;
          contact_id?: string | null;
          created_at?: string;
          expected_close_date?: string | null;
          id?: string;
          initial_price?: number | null;
          lost_reason?: string | null;
          monthly_price?: number | null;
          name?: string;
          notes?: string | null;
          organization_id?: string;
          owner_user_id?: string;
          stage?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "deals_organization_id_company_id_contact_id_fkey";
            columns: ["organization_id", "company_id", "contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["organization_id", "company_id", "id"];
          },
          {
            foreignKeyName: "deals_organization_id_company_id_fkey";
            columns: ["organization_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "deals_organization_id_company_id_fkey";
            columns: ["organization_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "company_overview";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "deals_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "deals_organization_id_owner_user_id_fkey";
            columns: ["organization_id", "owner_user_id"];
            isOneToOne: false;
            referencedRelation: "organization_members";
            referencedColumns: ["organization_id", "user_id"];
          },
        ];
      };
      improvement_types: {
        Row: {
          category: string;
          default_question: string | null;
          description: string | null;
          id: string;
          name: string;
          slug: string;
        };
        Insert: {
          category: string;
          default_question?: string | null;
          description?: string | null;
          id?: string;
          name: string;
          slug: string;
        };
        Update: {
          category?: string;
          default_question?: string | null;
          description?: string | null;
          id?: string;
          name?: string;
          slug?: string;
        };
        Relationships: [];
      };
      industry_recommendations: {
        Row: {
          id: string;
          improvement_type_id: string;
          industry: string;
          priority: number;
        };
        Insert: {
          id?: string;
          improvement_type_id: string;
          industry: string;
          priority: number;
        };
        Update: {
          id?: string;
          improvement_type_id?: string;
          industry?: string;
          priority?: number;
        };
        Relationships: [
          {
            foreignKeyName: "industry_recommendations_improvement_type_id_fkey";
            columns: ["improvement_type_id"];
            isOneToOne: false;
            referencedRelation: "improvement_types";
            referencedColumns: ["id"];
          },
        ];
      };
      organization_invitations: {
        Row: {
          accepted_at: string | null;
          created_at: string;
          email: string;
          expires_at: string;
          id: string;
          invited_by: string | null;
          organization_id: string;
          role: string;
        };
        Insert: {
          accepted_at?: string | null;
          created_at?: string;
          email: string;
          expires_at?: string;
          id?: string;
          invited_by?: string | null;
          organization_id: string;
          role: string;
        };
        Update: {
          accepted_at?: string | null;
          created_at?: string;
          email?: string;
          expires_at?: string;
          id?: string;
          invited_by?: string | null;
          organization_id?: string;
          role?: string;
        };
        Relationships: [
          {
            foreignKeyName: "organization_invitations_invited_by_fkey";
            columns: ["invited_by"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "organization_invitations_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      organization_members: {
        Row: {
          created_at: string;
          organization_id: string;
          role: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          organization_id: string;
          role: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          organization_id?: string;
          role?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "organization_members_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "organization_members_user_id_fkey";
            columns: ["user_id"];
            isOneToOne: false;
            referencedRelation: "profiles";
            referencedColumns: ["id"];
          },
        ];
      };
      organizations: {
        Row: {
          created_at: string;
          id: string;
          name: string;
          updated_at: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          name: string;
          updated_at?: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          name?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      pain_points: {
        Row: {
          company_id: string;
          created_at: string;
          description: string | null;
          id: string;
          organization_id: string;
          severity: number | null;
          type: string;
        };
        Insert: {
          company_id: string;
          created_at?: string;
          description?: string | null;
          id?: string;
          organization_id: string;
          severity?: number | null;
          type: string;
        };
        Update: {
          company_id?: string;
          created_at?: string;
          description?: string | null;
          id?: string;
          organization_id?: string;
          severity?: number | null;
          type?: string;
        };
        Relationships: [
          {
            foreignKeyName: "pain_points_organization_id_company_id_fkey";
            columns: ["organization_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "pain_points_organization_id_company_id_fkey";
            columns: ["organization_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "company_overview";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "pain_points_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      profiles: {
        Row: {
          avatar_url: string | null;
          created_at: string;
          email: string;
          id: string;
          name: string;
          updated_at: string;
        };
        Insert: {
          avatar_url?: string | null;
          created_at?: string;
          email: string;
          id: string;
          name?: string;
          updated_at?: string;
        };
        Update: {
          avatar_url?: string | null;
          created_at?: string;
          email?: string;
          id?: string;
          name?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      proposals: {
        Row: {
          automation_config: Json | null;
          company_id: string;
          created_at: string;
          description: string | null;
          expected_benefit: string | null;
          generated_by: string;
          id: string;
          organization_id: string;
          reason: string | null;
          status: string;
          title: string;
          type: string;
          updated_at: string;
        };
        Insert: {
          automation_config?: Json | null;
          company_id: string;
          created_at?: string;
          description?: string | null;
          expected_benefit?: string | null;
          generated_by?: string;
          id?: string;
          organization_id: string;
          reason?: string | null;
          status?: string;
          title: string;
          type: string;
          updated_at?: string;
        };
        Update: {
          automation_config?: Json | null;
          company_id?: string;
          created_at?: string;
          description?: string | null;
          expected_benefit?: string | null;
          generated_by?: string;
          id?: string;
          organization_id?: string;
          reason?: string | null;
          status?: string;
          title?: string;
          type?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "proposals_organization_id_company_id_fkey";
            columns: ["organization_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "proposals_organization_id_company_id_fkey";
            columns: ["organization_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "company_overview";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "proposals_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
      tasks: {
        Row: {
          assigned_user_id: string;
          company_id: string;
          contact_id: string | null;
          created_at: string;
          description: string | null;
          due_at: string | null;
          id: string;
          organization_id: string;
          status: string;
          title: string;
          type: string;
          updated_at: string;
        };
        Insert: {
          assigned_user_id: string;
          company_id: string;
          contact_id?: string | null;
          created_at?: string;
          description?: string | null;
          due_at?: string | null;
          id?: string;
          organization_id: string;
          status?: string;
          title: string;
          type: string;
          updated_at?: string;
        };
        Update: {
          assigned_user_id?: string;
          company_id?: string;
          contact_id?: string | null;
          created_at?: string;
          description?: string | null;
          due_at?: string | null;
          id?: string;
          organization_id?: string;
          status?: string;
          title?: string;
          type?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: "tasks_organization_id_assigned_user_id_fkey";
            columns: ["organization_id", "assigned_user_id"];
            isOneToOne: false;
            referencedRelation: "organization_members";
            referencedColumns: ["organization_id", "user_id"];
          },
          {
            foreignKeyName: "tasks_organization_id_company_id_contact_id_fkey";
            columns: ["organization_id", "company_id", "contact_id"];
            isOneToOne: false;
            referencedRelation: "contacts";
            referencedColumns: ["organization_id", "company_id", "id"];
          },
          {
            foreignKeyName: "tasks_organization_id_company_id_fkey";
            columns: ["organization_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "companies";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "tasks_organization_id_company_id_fkey";
            columns: ["organization_id", "company_id"];
            isOneToOne: false;
            referencedRelation: "company_overview";
            referencedColumns: ["organization_id", "id"];
          },
          {
            foreignKeyName: "tasks_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Views: {
      company_overview: {
        Row: {
          address: string | null;
          assigned_user_id: string | null;
          assigned_user_name: string | null;
          business_description: string | null;
          capital: number | null;
          city: string | null;
          company_status: string | null;
          contact_url: string | null;
          corporate_number: string | null;
          created_at: string | null;
          employee_max: number | null;
          employee_min: number | null;
          id: string | null;
          industry: string | null;
          industry_subcategory: string | null;
          last_contact_at: string | null;
          name: string | null;
          next_task: Json | null;
          organization_id: string | null;
          phone: string | null;
          prefecture: string | null;
          source: string | null;
          updated_at: string | null;
          website_url: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "companies_organization_id_assigned_user_id_fkey";
            columns: ["organization_id", "assigned_user_id"];
            isOneToOne: false;
            referencedRelation: "organization_members";
            referencedColumns: ["organization_id", "user_id"];
          },
          {
            foreignKeyName: "companies_organization_id_fkey";
            columns: ["organization_id"];
            isOneToOne: false;
            referencedRelation: "organizations";
            referencedColumns: ["id"];
          },
        ];
      };
    };
    Functions: {
      allow_auth_attempt: {
        Args: { operation: string; subject: string };
        Returns: boolean;
      };
      preview_company_import: {
        Args: { org: string; rows: Json };
        Returns: Json;
      };
      confirm_company_import: {
        Args: { org: string; preview_id: string; selected_rows: number[] };
        Returns: string[];
      };
      next_company: {
        Args: { org: string; company: string };
        Returns: { id: string; name: string }[];
      };
      accept_invitation: { Args: { invitation_id: string }; Returns: string };
      create_organization: { Args: { org_name: string }; Returns: string };
      dashboard_counts: {
        Args: { day_end: string; day_start: string; org: string };
        Returns: Json;
      };
      invite_member: {
        Args: { invite_email: string; invite_role: string; org: string };
        Returns: string;
      };
      manage_member: {
        Args: { member_id: string; new_role?: string; org: string };
        Returns: undefined;
      };
      my_invitations: {
        Args: Record<PropertyKey, never>;
        Returns: {
          expires_at: string;
          id: string;
          organization_name: string;
          role: string;
        }[];
      };
      record_activity: {
        Args: { company: string; org: string; payload: Json };
        Returns: string;
      };
      revoke_invitation: {
        Args: { invitation_id: string; org: string };
        Returns: undefined;
      };
    };
    Enums: {
      [_ in never]: never;
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<
  keyof Database,
  "public"
>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {},
  },
} as const;
