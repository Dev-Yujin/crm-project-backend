const meetingRecordingTypeDefs = `#graphql
  type MeetingRecordingSegment {
    key: String!
    durationSeconds: Int!
  }

  type MeetingRecordingResult {
    title: String!
    summary: String!
    cleanedTranscript: String!
    durationSeconds: Int!
    warnings: [String!]!
  }

  type AiNotesUsage {
    secondsUsed: Int!
    secondsLimit: Int!
    periodEnd: String!
  }

  type Mutation {
    "Admin-only. First call for a new sessionId is the AI-notes quota checkpoint."
    requestMeetingRecordingUploadUrl(
      sessionId: ID!
      segmentIndex: Int!
      contentType: String!
      sizeBytes: Int!
    ): UploadTarget!

    "Admin-only. Records a segment's real R2 size and reported duration."
    confirmMeetingRecordingSegment(
      sessionId: ID!
      segmentIndex: Int!
      key: String!
      sizeBytes: Int!
      durationSeconds: Int!
    ): MeetingRecordingSegment!

    "Admin-only. Runs the Fish Audio -> Claude Haiku pipeline and returns the finished note."
    finishMeetingRecording(sessionId: ID!): MeetingRecordingResult!
  }

  type Query {
    "Admin-only. Current month's AI meeting-notes usage against the plan limit."
    myAiNotesUsage: AiNotesUsage!
  }
`;

export default meetingRecordingTypeDefs;
