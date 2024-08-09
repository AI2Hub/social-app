import {
  AppBskyFeedDefs,
  AppBskyFeedPostgate,
  AtUri,
  BskyAgent,
} from '@atproto/api'
import {useMutation, useQuery, useQueryClient} from '@tanstack/react-query'

import {networkRetry, retry} from '#/lib/async/retry'
import {logger} from '#/logger'
import {updatePostShadow} from '#/state/cache/post-shadow'
import {useGetPosts} from '#/state/queries/post'
import {
  createMaybeDetachedQuoteEmbed,
  createPostgateRecord,
  mergePostgateRecords,
  POSTGATE_COLLECTION,
} from '#/state/queries/postgate/util'
import {useAgent} from '#/state/session'

export async function getPostgateRecord({
  agent,
  postUri,
}: {
  agent: BskyAgent
  postUri: string
}): Promise<AppBskyFeedPostgate.Record | undefined> {
  const urip = new AtUri(postUri)

  if (!urip.host.startsWith('did:')) {
    const res = await agent.resolveHandle({
      handle: urip.host,
    })
    urip.host = res.data.did
  }

  try {
    const {data} = await retry(
      2,
      e => {
        /*
         * If the record doesn't exist, we want to return null instead of
         * throwing an error. NB: This will also catch reference errors, such as
         * a typo in the URI.
         */
        if (e.message.includes(`Could not locate record:`)) {
          return false
        }
        return true
      },
      () =>
        agent.api.com.atproto.repo.getRecord({
          repo: urip.host,
          collection: POSTGATE_COLLECTION,
          rkey: urip.rkey,
        }),
    )

    if (data.value && AppBskyFeedPostgate.isRecord(data.value)) {
      return data.value
    } else {
      return undefined
    }
  } catch (e: any) {
    /*
     * If the record doesn't exist, we want to return null instead of
     * throwing an error. NB: This will also catch reference errors, such as
     * a typo in the URI.
     */
    if (e.message.includes(`Could not locate record:`)) {
      return undefined
    } else {
      throw new Error(`Failed to get postgate record`, {cause: e})
    }
  }
}

export async function writePostgateRecord({
  agent,
  postUri,
  postgate,
}: {
  agent: BskyAgent
  postUri: string
  postgate: AppBskyFeedPostgate.Record
}) {
  const postUrip = new AtUri(postUri)

  await networkRetry(2, () =>
    agent.api.com.atproto.repo.putRecord({
      repo: agent.session!.did,
      collection: POSTGATE_COLLECTION,
      rkey: postUrip.rkey,
      record: postgate,
    }),
  )
}

export async function upsertPostgate(
  {
    agent,
    postUri,
  }: {
    agent: BskyAgent
    postUri: string
  },
  callback: (
    postgate: AppBskyFeedPostgate.Record | undefined,
  ) => Promise<AppBskyFeedPostgate.Record | undefined>,
) {
  const prev = await getPostgateRecord({
    agent,
    postUri,
  })
  const next = await callback(prev)
  if (!next) return
  await writePostgateRecord({
    agent,
    postUri,
    postgate: next,
  })
}

export const createPostgateQueryKey = (postUri: string) => [
  'postgate-record',
  postUri,
]
export function usePostgateQuery({postUri}: {postUri: string}) {
  const agent = useAgent()
  return useQuery({
    queryKey: createPostgateQueryKey(postUri),
    queryFn() {
      return getPostgateRecord({agent, postUri})
    },
  })
}

export function useToggleQuoteDetachmentMutation() {
  const agent = useAgent()
  const queryClient = useQueryClient()
  const getPosts = useGetPosts()

  return useMutation({
    mutationFn: async ({
      post,
      quoteUri,
      action,
    }: {
      post: AppBskyFeedDefs.PostView
      quoteUri: string
      action: 'detach' | 'reattach'
    }) => {
      await upsertPostgate({agent, postUri: quoteUri}, async prev => {
        if (prev) {
          if (action === 'detach') {
            return mergePostgateRecords(prev, {
              detachedQuotes: [post.uri],
            })
          } else if (action === 'reattach') {
            return {
              ...prev,
              detachedQuotes:
                prev.detachedQuotes?.filter(uri => uri !== post.uri) || [],
            }
          }
        } else {
          if (action === 'detach') {
            return createPostgateRecord({
              post: quoteUri,
              detachedQuotes: [post.uri],
            })
          }
        }
      })
    },
    async onSuccess(_data, {post, quoteUri, action}) {
      if (action === 'detach') {
        updatePostShadow(queryClient, post.uri, {
          embed: createMaybeDetachedQuoteEmbed({
            post,
            quote: undefined,
            quoteUri,
            detached: true,
          }),
        })
      } else if (action === 'reattach') {
        try {
          const [quote] = await getPosts({uris: [quoteUri]})
          updatePostShadow(queryClient, post.uri, {
            embed: createMaybeDetachedQuoteEmbed({
              post,
              quote,
              quoteUri: undefined,
              detached: false,
            }),
          })
        } catch (e: any) {
          // ok if this fails, it's just optimistic UI
          logger.error(`Postgate: failed to get quote post for re-attachment`, {
            safeMessage: e.message,
          })
        }
      }
    },
  })
}

export function useToggleQuotepostEnabledMutation() {
  const agent = useAgent()

  return useMutation({
    mutationFn: async ({
      postUri,
      action,
    }: {
      postUri: string
      action: 'enable' | 'disable'
    }) => {
      await upsertPostgate({agent, postUri: postUri}, async prev => {
        if (prev) {
          if (action === 'disable') {
            return mergePostgateRecords(prev, {
              quotepostRules: [{$type: 'app.bsky.feed.postgate#disableRule'}],
            })
          } else if (action === 'enable') {
            return {
              ...prev,
              quotepostRules: [],
            }
          }
        } else {
          if (action === 'disable') {
            return createPostgateRecord({
              post: postUri,
              quotepostRules: [{$type: 'app.bsky.feed.postgate#disableRule'}],
            })
          }
        }
      })
    },
  })
}
