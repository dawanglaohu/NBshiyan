import { z } from 'zod';
import {
  BodyTextSchema,
  EmailSchema,
  IdSchema,
  LocaleSchema,
  NonNegativeIntSchema,
  ProductSlugSchema,
  QueryBooleanSchema,
  SitePathSchema,
  UtcDateTimeSchema,
  UuidSchema,
  makeCursorSchema,
  queryIntSchema,
} from './common';

export const ConversationStatusSchema = z.enum(['OPEN', 'CLOSED']);
export type ConversationStatus = z.infer<typeof ConversationStatusSchema>;

export const ChatSenderSchema = z.enum(['VISITOR', 'OPERATOR']);
export type ChatSender = z.infer<typeof ChatSenderSchema>;

export const ChatConversationParamsSchema = z.object({
  id: IdSchema,
}).strict();
export type ChatConversationParams = z.infer<typeof ChatConversationParamsSchema>;

export const ChatSessionRequestSchema = z.object({
  locale: LocaleSchema,
}).strict();
export type ChatSessionRequest = z.infer<typeof ChatSessionRequestSchema>;

export const ConversationCreateRequestSchema = z.object({
  clientConversationId: UuidSchema,
  clientMessageId: UuidSchema,
  locale: LocaleSchema,
  bodyText: BodyTextSchema,
  email: z.preprocess(
    (value) => typeof value === 'string' && !/[\r\n]/.test(value) && value.trim() === '' ? undefined : value,
    EmailSchema.optional(),
  ),
  productSlug: ProductSlugSchema.optional(),
  sourcePath: SitePathSchema.optional(),
}).strict();
export type ConversationCreateRequest = z.infer<typeof ConversationCreateRequestSchema>;

export const ChatMessageRequestSchema = z.object({
  clientMessageId: UuidSchema,
  bodyText: BodyTextSchema,
}).strict();
export type ChatMessageRequest = z.infer<typeof ChatMessageRequestSchema>;

export const ChatReadRequestSchema = z.object({
  lastReadSeq: NonNegativeIntSchema,
}).strict();
export type ChatReadRequest = z.infer<typeof ChatReadRequestSchema>;

export const ChatMessagesQuerySchema = z.object({
  afterSeq: queryIntSchema(2147483647).default(0),
  limit: queryIntSchema(100).refine((value) => value > 0, 'Limit must be positive.').default(50),
}).strict();
export type ChatMessagesQuery = z.infer<typeof ChatMessagesQuerySchema>;

export const ChatCursorSchema = makeCursorSchema('updatedAt');

export const ChatSummaryQuerySchema = z.object({
  status: ConversationStatusSchema.optional(),
  cursor: ChatCursorSchema.optional(),
  limit: queryIntSchema(100).refine((value) => value > 0, 'Limit must be positive.').default(25),
  unreadOnly: QueryBooleanSchema.default(false),
}).strict();
export type ChatSummaryQuery = z.infer<typeof ChatSummaryQuerySchema>;

export const ChatStatusRequestSchema = z.object({
  status: z.literal('CLOSED'),
  expectedVersion: NonNegativeIntSchema,
}).strict();
export type ChatStatusRequest = z.infer<typeof ChatStatusRequestSchema>;

export const ChatSessionDTOSchema = z.object({
  available: z.boolean(),
  expiresAt: UtcDateTimeSchema,
}).strict();
export type ChatSessionDTO = z.infer<typeof ChatSessionDTOSchema>;

export const ChatMessageDTOSchema = z.object({
  id: IdSchema,
  seq: NonNegativeIntSchema.refine((value) => value > 0, 'Message sequence must be positive.'),
  sender: ChatSenderSchema,
  bodyText: BodyTextSchema,
  createdAt: UtcDateTimeSchema,
}).strict();
export type ChatMessageDTO = z.infer<typeof ChatMessageDTOSchema>;

export const MessageReceivedDTOSchema = z.object({
  message: ChatMessageDTOSchema,
  receivedAt: UtcDateTimeSchema,
  duplicate: z.boolean(),
}).strict();
export type MessageReceivedDTO = z.infer<typeof MessageReceivedDTOSchema>;

export const ConversationReceivedDTOSchema = MessageReceivedDTOSchema.extend({
  conversationId: IdSchema,
}).strict();
export type ConversationReceivedDTO = z.infer<typeof ConversationReceivedDTOSchema>;

export const ReadDTOSchema = z.object({
  lastReadSeq: NonNegativeIntSchema,
}).strict();
export type ReadDTO = z.infer<typeof ReadDTOSchema>;

const ChatConversationObjectSchema = z.object({
  id: IdSchema,
  locale: LocaleSchema,
  productSlug: ProductSlugSchema.nullable(),
  sourcePath: SitePathSchema.nullable(),
  status: ConversationStatusSchema,
  version: NonNegativeIntSchema,
  createdAt: UtcDateTimeSchema,
  updatedAt: UtcDateTimeSchema,
  lastActivityAt: UtcDateTimeSchema,
  retainUntil: UtcDateTimeSchema,
  anonymizedAt: UtcDateTimeSchema.nullable(),
}).strict();

function checkConversationTimes(
  value: z.infer<typeof ChatConversationObjectSchema>,
  context: z.RefinementCtx,
) {
  const createdAt = Date.parse(value.createdAt);
  if (Date.parse(value.updatedAt) < createdAt) {
    context.addIssue({ code: 'custom', path: ['updatedAt'], message: 'Updated time precedes creation.' });
  }
  if (Date.parse(value.lastActivityAt) < createdAt) {
    context.addIssue({ code: 'custom', path: ['lastActivityAt'], message: 'Activity time precedes creation.' });
  }
  if (Date.parse(value.retainUntil) <= Date.parse(value.lastActivityAt)) {
    context.addIssue({ code: 'custom', path: ['retainUntil'], message: 'Retention must follow activity.' });
  }
}

export const ChatConversationDTOSchema = ChatConversationObjectSchema.superRefine(checkConversationTimes);
export type ChatConversationDTO = z.infer<typeof ChatConversationDTOSchema>;

const AdminChatConversationObjectSchema = ChatConversationObjectSchema.extend({
  email: EmailSchema.nullable(),
}).strict();

export const AdminChatConversationDTOSchema = AdminChatConversationObjectSchema.superRefine(checkConversationTimes);
export type AdminChatConversationDTO = z.infer<typeof AdminChatConversationDTOSchema>;

const chatSyncShape = {
  messages: z.array(ChatMessageDTOSchema).max(100),
  lastSeq: NonNegativeIntSchema,
  nextAfterSeq: NonNegativeIntSchema,
  hasMore: z.boolean(),
  read: ReadDTOSchema,
};

const ChatSyncObjectSchema = z.object({
  conversation: ChatConversationDTOSchema,
  ...chatSyncShape,
}).strict();

function checkChatSync(
  value: z.infer<typeof ChatSyncObjectSchema>,
  context: z.RefinementCtx,
) {
  if (value.read.lastReadSeq > value.lastSeq) {
    context.addIssue({ code: 'custom', path: ['read', 'lastReadSeq'], message: 'Read sequence exceeds the conversation.' });
  }
  if (value.nextAfterSeq > value.lastSeq) {
    context.addIssue({ code: 'custom', path: ['nextAfterSeq'], message: 'Next sequence exceeds the conversation.' });
  }
  let previousSeq = 0;
  value.messages.forEach((message, index) => {
    if (message.seq <= previousSeq || (index > 0 && message.seq !== previousSeq + 1) || message.seq > value.lastSeq) {
      context.addIssue({ code: 'custom', path: ['messages', index, 'seq'], message: 'Messages must be consecutive within the page.' });
    }
    previousSeq = message.seq;
  });
  if (value.messages.length > 0 && previousSeq !== value.nextAfterSeq) {
    context.addIssue({ code: 'custom', path: ['nextAfterSeq'], message: 'Next sequence must equal the last returned message sequence.' });
  }
  if (value.hasMore && value.nextAfterSeq >= value.lastSeq) {
    context.addIssue({ code: 'custom', path: ['hasMore'], message: 'No messages remain after the next sequence.' });
  }
}

export const ChatSyncDTOSchema = ChatSyncObjectSchema.superRefine(checkChatSync);
export type ChatSyncDTO = z.infer<typeof ChatSyncDTOSchema>;

export const AdminChatSyncDTOSchema = z.object({
  conversation: AdminChatConversationDTOSchema,
  ...chatSyncShape,
}).strict().superRefine(checkChatSync);
export type AdminChatSyncDTO = z.infer<typeof AdminChatSyncDTOSchema>;

export const ChatSummaryDTOSchema = AdminChatConversationObjectSchema.extend({
  lastSeq: NonNegativeIntSchema,
  lastReadSeq: NonNegativeIntSchema,
}).strict().superRefine((value, context) => {
  checkConversationTimes(value, context);
  if (value.lastReadSeq > value.lastSeq) {
    context.addIssue({ code: 'custom', path: ['lastReadSeq'], message: 'Read sequence exceeds the conversation.' });
  }
});
export type ChatSummaryDTO = z.infer<typeof ChatSummaryDTOSchema>;

export const ChatSummaryPageDTOSchema = z.object({
  items: z.array(ChatSummaryDTOSchema).max(100),
  nextCursor: ChatCursorSchema.nullable(),
  hasMore: z.boolean(),
  unreadTotal: NonNegativeIntSchema,
}).strict().superRefine((value, context) => {
  if (value.hasMore !== (value.nextCursor !== null)) {
    context.addIssue({ code: 'custom', path: ['nextCursor'], message: 'A next cursor is required exactly when another page exists.' });
  }
});
export type ChatSummaryPageDTO = z.infer<typeof ChatSummaryPageDTOSchema>;

export const ChatStatusDTOSchema = z.object({
  status: ConversationStatusSchema,
  version: NonNegativeIntSchema,
  updatedAt: UtcDateTimeSchema,
}).strict();
export type ChatStatusDTO = z.infer<typeof ChatStatusDTOSchema>;
