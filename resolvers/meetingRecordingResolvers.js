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
  validateSegmentDuration,
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

      // Defense against cross-tenant reference: getOrCreateSession looks up by
      // sessionId alone, so a caller who knows/guesses another group's sessionId would
      // otherwise silently get that group's row back.
      if (session.groupId !== groupId) {
        throw new GraphQLError('Invalid recording session.', { extensions: { code: 'BAD_USER_INPUT' } });
      }

      // Derived from actual DB state (did getOrCreateSession just insert the row?),
      // not from the client-supplied segmentIndex — a client requesting uploads
      // starting at segmentIndex 1 must not be able to skip quota enforcement.
      const isNewSession = session.created;

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
      const uploadedBy = `admin:${context.user.id}`;

      try {
        validateRecordingKey(key, groupId, sessionId);
      } catch (err) {
        throw new GraphQLError(err.message, { extensions: { code: 'BAD_USER_INPUT' } });
      }
      validateSegmentSize(sizeBytes);
      try {
        validateSegmentDuration(durationSeconds);
      } catch (err) {
        throw new GraphQLError(err.message, { extensions: { code: 'BAD_USER_INPUT' } });
      }

      // Defensive ownership check: getOrCreateSession is idempotent (a no-op read if
      // the session already exists), so calling it here just confirms the session
      // being confirmed against actually belongs to the caller's own group, closing
      // the same cross-tenant-write gap as the check in requestMeetingRecordingUploadUrl.
      const session = await getOrCreateSession(sessionId, groupId, uploadedBy);
      if (session.groupId !== groupId) {
        throw new GraphQLError('Invalid recording session.', { extensions: { code: 'BAD_USER_INPUT' } });
      }

      let actualSizeBytes;
      try {
        actualSizeBytes = await headR2ObjectSize(key);
        validateSegmentSize(actualSizeBytes);
      } catch (err) {
        console.error('headR2ObjectSize failed while confirming a meeting recording segment:', err);
        throw new GraphQLError('The uploaded segment could not be verified — try uploading again.', {
          extensions: { code: 'UPLOAD_NOT_FOUND' },
        });
      }

      // durationSeconds is stored on the row for observability/debugging only — it is
      // NOT the metering source of truth. finishMeetingRecording meters usage off Fish's
      // own server-observed duration per segment, so a client lying about this value
      // cannot corrupt the usage ledger even though it passed validateSegmentDuration.
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

      // Everything from here through addSecondsUsed is wrapped in one try/catch: any
      // failure in this span — formatMeetingTranscript, markSessionStatus('completed'),
      // or addSecondsUsed — must mark the session 'failed' (making it retryable) rather
      // than leaving it stuck in 'processing' forever, or worse, leaving it 'completed'
      // while usage metering silently never happened.
      try {
        for (const segment of segments) {
          try {
            const downloadUrl = await createDownloadUrl(segment.r2Key);
            const response = await fetch(downloadUrl);
            if (!response.ok) throw new Error(`R2 fetch failed (${response.status})`);
            const webmBuffer = Buffer.from(await response.arrayBuffer());

            // Meter off Fish's own server-observed duration for this segment, not the
            // client-declared segment.durationSeconds stored at confirm time — the
            // client value is untrusted and must never be able to corrupt the usage
            // ledger, by construction rather than by validation alone.
            const result = await transcribeSegment(webmBuffer, segment.segmentIndex);
            if (result.text?.trim()) {
              transcriptParts.push(result.text);
            }
            // Fish reports duration as a float (e.g. 9.36s); seconds_used is an
            // INTEGER column, so round per segment rather than truncating precision
            // in one lump sum at the end.
            totalDurationSeconds += Math.round(result.durationSeconds);
          } catch (err) {
            console.error(`Meeting recording segment ${segment.segmentIndex} transcription failed:`, err);
            warnings.push(`Segment ${segment.segmentIndex + 1} could not be transcribed.`);
          }
        }

        // A meeting where every segment was silent (empty/whitespace-only transcripts)
        // is indistinguishable from one where transcription failed entirely, for the
        // purposes of this error — route both through the same "nothing was saved" path.
        if (transcriptParts.length === 0) {
          await markSessionStatus(sessionId, 'failed', null);
          throw new GraphQLError('None of the recording could be transcribed. Nothing was saved.', {
            extensions: { code: 'TRANSCRIPTION_FAILED' },
          });
        }

        const fullTranscript = transcriptParts.join('\n\n');
        const note = await formatMeetingTranscript(fullTranscript);

        // Meter usage BEFORE marking the session completed — if addSecondsUsed throws,
        // the session stays 'processing' and falls into the catch below (marked
        // 'failed', retryable) instead of ending up 'completed' but never billed.
        await addSecondsUsed(groupId, totalDurationSeconds);
        await markSessionStatus(sessionId, 'completed', totalDurationSeconds);

        return {
          title: note.title,
          summary: note.summary,
          cleanedTranscript: note.cleanedTranscript,
          durationSeconds: totalDurationSeconds,
          warnings,
        };
      } catch (err) {
        if (err instanceof GraphQLError) throw err;
        console.error('finishMeetingRecording failed after entering processing:', err);
        await markSessionStatus(sessionId, 'failed', null);
        throw new GraphQLError(
          'Could not organize the notes into a summary. Your recording is saved — try again.',
          { extensions: { code: 'NOTE_FORMATTING_FAILED' } }
        );
      }
    },
  },
};

export default meetingRecordingResolvers;
