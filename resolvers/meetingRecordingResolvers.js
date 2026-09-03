import { GraphQLError } from 'graphql';
import { requireGroup } from '../utils/requireUser.js';
import { createUploadUrl, createDownloadUrl, headR2ObjectSize } from '../config/r2.js';
import { getOrCreateBilling } from '../models/billing.js';
import { getOrCreateAiNotesUsage, addSecondsUsed } from '../models/aiNotesUsage.js';
import {
  getOrCreateSession,
  insertSegment,
  getSessionWithSegments,
  markSessionStatus,
} from '../models/meetingRecording.js';
import {
  validateSegmentContentType,
  validateSegmentSize,
  validateRecordingKey,
  checkAiNotesQuota,
} from '../utils/meetingRecordings.js';
import { transcribeSegment } from '../services/fishTranscription.js';
import { formatMeetingTranscript } from '../services/meetingNotesFormatter.js';

const meetingRecordingResolvers = {
  Query: {
    myAiNotesUsage: async (_, __, context) => {
      const groupId = requireGroup(context);
      const [usage, billing] = await Promise.all([
        getOrCreateAiNotesUsage(groupId),
        getOrCreateBilling(groupId),
      ]);
      return {
        secondsUsed: usage.secondsUsed,
        secondsLimit: billing.limits.aiNotesHoursPerMonth * 3600,
        periodEnd: usage.periodEnd.toISOString(),
      };
    },
  },
  Mutation: {
    requestMeetingRecordingUploadUrl: async (_, { sessionId, segmentIndex, contentType, sizeBytes }, context) => {
      const groupId = requireGroup(context);
      const uploadedBy = `admin:${context.user.id}`;

      validateSegmentContentType(contentType);
      validateSegmentSize(sizeBytes);

      const session = await getOrCreateSession(sessionId, groupId, uploadedBy);
      const isNewSession = segmentIndex === 0;

      if (isNewSession) {
        const [usage, billing] = await Promise.all([
          getOrCreateAiNotesUsage(groupId),
          getOrCreateBilling(groupId),
        ]);
        try {
          checkAiNotesQuota(usage.secondsUsed, true, billing.limits.aiNotesHoursPerMonth);
        } catch (err) {
          throw new GraphQLError(err.message, { extensions: { code: 'AI_NOTES_QUOTA_EXCEEDED' } });
        }
      }

      const key = `meeting-recordings/${groupId}/${session.sessionId}/segment-${segmentIndex}.webm`;
      const uploadUrl = await createUploadUrl(key, contentType);

      return { uploadUrl, key };
    },

    confirmMeetingRecordingSegment: async (_, { sessionId, segmentIndex, key, sizeBytes, durationSeconds }, context) => {
      const groupId = requireGroup(context);

      try {
        validateRecordingKey(key, groupId, sessionId);
      } catch (err) {
        throw new GraphQLError(err.message, { extensions: { code: 'BAD_USER_INPUT' } });
      }
      validateSegmentSize(sizeBytes);

      let actualSizeBytes;
      try {
        actualSizeBytes = await headR2ObjectSize(key);
        validateSegmentSize(actualSizeBytes);
      } catch (err) {
        throw new GraphQLError('The uploaded segment could not be verified — try uploading again.', {
          extensions: { code: 'UPLOAD_NOT_FOUND' },
        });
      }

      await insertSegment(sessionId, groupId, segmentIndex, key, actualSizeBytes, durationSeconds);

      return { key, durationSeconds };
    },

    finishMeetingRecording: async (_, { sessionId }, context) => {
      const groupId = requireGroup(context);

      const { session, segments } = await getSessionWithSegments(sessionId, groupId);

      if (session.status === 'processing' || session.status === 'completed') {
        throw new GraphQLError('This recording is already being processed or has finished.', {
          extensions: { code: 'ALREADY_PROCESSED' },
        });
      }

      await markSessionStatus(sessionId, 'processing', null);

      const warnings = [];
      const transcriptParts = [];
      let totalDurationSeconds = 0;

      for (const segment of segments) {
        try {
          const downloadUrl = await createDownloadUrl(segment.r2Key);
          const response = await fetch(downloadUrl);
          if (!response.ok) throw new Error(`R2 fetch failed (${response.status})`);
          const webmBuffer = Buffer.from(await response.arrayBuffer());

          const result = await transcribeSegment(webmBuffer, segment.segmentIndex);
          transcriptParts.push(result.text);
          totalDurationSeconds += segment.durationSeconds;
        } catch (err) {
          warnings.push(`Segment ${segment.segmentIndex + 1} could not be transcribed.`);
        }
      }

      if (transcriptParts.length === 0) {
        await markSessionStatus(sessionId, 'failed', null);
        throw new GraphQLError('None of the recording could be transcribed. Nothing was saved.', {
          extensions: { code: 'TRANSCRIPTION_FAILED' },
        });
      }

      const fullTranscript = transcriptParts.join('\n\n');
      let note;
      try {
        note = await formatMeetingTranscript(fullTranscript);
      } catch (err) {
        await markSessionStatus(sessionId, 'failed', null);
        throw new GraphQLError(
          'Could not organize the notes into a summary. Your recording is saved — try again.',
          { extensions: { code: 'NOTE_FORMATTING_FAILED' } }
        );
      }

      await markSessionStatus(sessionId, 'completed', totalDurationSeconds);
      await addSecondsUsed(groupId, totalDurationSeconds);

      return {
        title: note.title,
        summary: note.summary,
        cleanedTranscript: note.cleanedTranscript,
        durationSeconds: totalDurationSeconds,
        warnings,
      };
    },
  },
};

export default meetingRecordingResolvers;
