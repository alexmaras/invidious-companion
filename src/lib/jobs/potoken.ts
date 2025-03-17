import { BG, buildURL, GOOG_API_KEY, USER_AGENT } from "bgutils";
import type { WebPoSignalOutput } from "bgutils";
import { JSDOM } from "jsdom";
import { Innertube, UniversalCache } from "youtubei.js";
import { fork } from "node:child_process";
import {
    youtubePlayerParsing,
    youtubeVideoInfo,
} from "../helpers/youtubePlayerHandling.ts";
import type { Config } from "../helpers/config.ts";
let getFetchClientLocation = "getFetchClient";
if (Deno.env.get("GET_FETCH_CLIENT_LOCATION")) {
    if (Deno.env.has("DENO_COMPILED")) {
        getFetchClientLocation = Deno.mainModule.replace("src/main.ts", "") +
            Deno.env.get("GET_FETCH_CLIENT_LOCATION");
    } else {
        getFetchClientLocation = Deno.env.get(
            "GET_FETCH_CLIENT_LOCATION",
        ) as string;
    }
}
const { getFetchClient } = await import(getFetchClientLocation);


import { z, ZodError } from "zod";

const InitialisedSchema = z.object({
    type: z.literal('initialised'),
    sessionPoToken: z.string(),
    visitorData: z.string(),
}).strict();

const ContentTokenSchema = z.object({
    type: z.literal('content-token'),
    contentToken: z.string(),
}).strict();

const MessageSchema = InitialisedSchema.or(ContentTokenSchema);

export type Message = z.infer<typeof MessageSchema>;

const forked: ReturnType<typeof fork>[] = [];

// Adapted from https://github.com/LuanRT/BgUtils/blob/main/examples/node/index.ts
export const poTokenGenerate = async (
    innertubeClient: Innertube,
    config: Config,
    innertubeClientCache: UniversalCache,
): Promise<{ innertubeClient: Innertube; tokenMinter: (videoId: string) => Promise<string> }> => {
    return new Promise((resolve) => {
        const forkLocation = Deno.mainModule.replace('file://', '').replace('main.ts', '') + 'lib/jobs/fork.ts';
        console.log({ forkLocation });
        try {
        const forkedCode = fork(forkLocation);
        console.log("SENDING CONFIG");
        forkedCode.send({ type: 'config', config });
        console.log("pushing onto array");
        forked.push(forkedCode);
        console.log("making minter");
        const minter = (videoId: string): Promise<string> => {
            return new Promise((resolve) => {
                forkedCode.send({ type: 'content-token-request', videoId });
                forkedCode.on('message', (message) => {
                    const parsedMessage = MessageSchema.parse(message);
                    if (parsedMessage.type === 'content-token') {
                        console.log({ parsedMessage });
                        resolve(parsedMessage.contentToken);
                    }
                });
            });
        }
        forkedCode.on('message', (message) => {
            try {
            const parsedMessage = MessageSchema.parse(message);

            if (parsedMessage.type === 'initialised') {
                for (let i = 0; i < forked.length - 1; i++) {
                    console.log("KILLING:", { forked });
                    forked.shift()?.kill()
                }
                resolve(initialiseStuff({
                    sessionPoToken: parsedMessage.sessionPoToken,
                    visitorData: parsedMessage.visitorData,
                    config,
                    innertubeClientCache,
                    integrityTokenBasedMinter: minter
                }));
            }
            } catch (err) {
                console.log({ err });
            }
        });
        } catch (err) {
            console.log({ err });
        }
    });
};

async function initialiseStuff({
    sessionPoToken,
    visitorData,
    config,
    innertubeClientCache,
    integrityTokenBasedMinter,
}: {
    sessionPoToken: string,
    visitorData: string,
    config: Config,
    innertubeClientCache: UniversalCache,
    integrityTokenBasedMinter: (videoId: string) => Promise<string>,
}) {
    const instantiatedInnertubeClient = await Innertube.create({
        enable_session_cache: false,
        po_token: sessionPoToken,
        visitor_data: visitorData,
        fetch: getFetchClient(config),
        cache: innertubeClientCache,
        generate_session_locally: true,
    });
    const fetchImpl = await getFetchClient(config);

    try {
        const feed = await instantiatedInnertubeClient.getTrending();
        // get all videos and shuffle them randomly to avoid using the same trending video over and over
        const videos = feed.videos
            .filter((video) => video.type === "Video")
            .map((value) => ({ value, sort: Math.random() }))
            .sort((a, b) => a.sort - b.sort)
            .map(({ value }) => value);

        const video = videos.find((video) => "id" in video);
        if (!video) {
            throw new Error("no videos with id found in trending");
        }

        const youtubePlayerResponseJson = await youtubePlayerParsing({
            innertubeClient: instantiatedInnertubeClient,
            videoId: video.id,
            config,
            tokenMinter: integrityTokenBasedMinter,
            overrideCache: true,
        });
        const videoInfo = youtubeVideoInfo(
            instantiatedInnertubeClient,
            youtubePlayerResponseJson,
        );
        const validFormat = videoInfo.streaming_data?.adaptive_formats[0];
        if (!validFormat) {
            throw new Error(
                "failed to find valid video with adaptive format to check token against",
            );
        }
        const result = await fetchImpl(validFormat?.url, { method: "HEAD" });
        if (result.status !== 200) {
            throw new Error(
                `did not get a 200 when checking video, got ${result.status} instead`,
            );
        }
    } catch (err) {
        console.log("Failed to get valid PO token, will retry", { err });
        throw err;
    }

    return {
        innertubeClient: instantiatedInnertubeClient,
        tokenMinter: integrityTokenBasedMinter,
    };
}
