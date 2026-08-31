const billingTypeDefs = `#graphql
  enum PlanTier { STARTER BUSINESS SCALE }

  type PlanLimits {
    tier: PlanTier!
    name: String!
    priceMonthlyUsd: Float!
    adminLimit: Int!
    memberLimit: Int!
    storageGb: Int!
    aiNotesHoursPerMonth: Int!
  }

  "One per group. status is one of: trialing, active, past_due, canceled, incomplete."
  type Billing {
    groupId: ID!
    status: String!
    plan: PlanTier
    limits: PlanLimits!
    trialEndsAt: String
    currentPeriodEnd: String
    isLocked: Boolean!
    storageBytesUsed: Float!
  }

  type CheckoutSession { url: String! }
  type PortalSession { url: String! }

  type Query {
    "Resolves for both an admin (Supabase session) and a member (cookie/token) caller."
    myBilling: Billing!
    "No auth required — also used on the public pricing page."
    plans: [PlanLimits!]!
  }

  type Mutation {
    "Admin-only. Returns a Stripe Checkout URL to redirect the browser to."
    createCheckoutSession(plan: PlanTier!): CheckoutSession!
    "Admin-only. Returns a Stripe Billing Portal URL to redirect the browser to."
    createBillingPortalSession: PortalSession!
  }
`;

export default billingTypeDefs;
