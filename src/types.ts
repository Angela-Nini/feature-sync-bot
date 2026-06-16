export type PlanAvailability = {
  standardSaas: string;
  enterpriseSaas: string;
  businessCriticalAndByoc: string;
};

export type RegionAvailability = {
  aws: string;
  googleCloud: string;
  azure: string;
};

export type RelatedDoc = {
  title: string;
  url?: string;
  docId?: string;
};

export type FeatureAvailability = {
  feature: string;
  plan?: PlanAvailability;
  region?: RegionAvailability;
  relatedDocs: RelatedDoc[];
};

export type DraftBlock = {
  title: "Plan Availability" | "Region Availability";
  titleUrl: string;
  body: string;
};

export type PendingJob = {
  jobId: string;
  chatId: string;
  triggerUserId: string;
  feature: string;
  confirmationCode: string;
  targetDocs: RelatedDoc[];
  draftBlocks: DraftBlock[];
  status: "pending" | "completed" | "failed";
  createdAt: string;
  expiresAt: string;
};
