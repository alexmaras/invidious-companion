import process from 'node:process';

import { z, ZodType, ZodError } from "zod";
import { Config, ConfigSchema } from "../helpers/config.ts";
import { BG, buildURL, GOOG_API_KEY, USER_AGENT } from "bgutils";
import type { WebPoSignalOutput } from "bgutils";
import { JSDOM } from "jsdom";
import { Innertube, UniversalCache } from "youtubei.js";
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

const innertubeClient = await Innertube.create({
    enable_session_cache: false,
    user_agent: USER_AGENT,
    retrieve_player: false,
});

const InitialisedSchema = z.object({
    type: z.literal('config'),
    config: ConfigSchema,
}).strict();

const ContentTokenSchema = z.object({
    type: z.literal('content-token-request'),
    videoId: z.string(),
}).strict();

const MessageSchema = InitialisedSchema.or(ContentTokenSchema);

export type Message = z.infer<typeof MessageSchema>;

let minter: BG.WebPoMinter;


process.on('message', (message: Message) => {
    if (message.type === 'config') {
        runShit({ config: message.config }).then((returnedMinter) => { minter = returnedMinter });
    }
    if (message.type === 'content-token-request') {
        if (!minter) {
            throw new Error("Minter not yet ready");
        }
        minter.mintAsWebsafeString(message.videoId).then((contentToken) => {
            if (!process.send) {
                throw new Error('Not run as child process')
            }
            process.send({ type: 'content-token', contentToken })
        });
    }
});

async function runShit({ config }: { config: Config }) {
    if (!process.send) {
        throw new Error('Not run as child process')
    }

    const fetchImpl = await getFetchClient(config);

    const visitorData = innertubeClient.session.context.client.visitorData;

    if (!visitorData) {
        throw new Error("Could not get visitor data");
    }

    const dom = new JSDOM(
        '<!DOCTYPE html><html lang="en"><head><title></title></head><body></body></html>',
        {
            url: "https://www.youtube.com/",
            referrer: "https://www.youtube.com/",
            userAgent: USER_AGENT,
        },
    );

    Object.assign(globalThis, {
        window: dom.window,
        document: dom.window.document,
        location: dom.window.location,
        origin: dom.window.origin,
    });

    if (!Reflect.has(globalThis, "navigator")) {
        Object.defineProperty(globalThis, "navigator", {
            value: dom.window.navigator,
        });
    }

    const challengeResponse = await innertubeClient.getAttestationChallenge(
        "ENGAGEMENT_TYPE_UNBOUND",
    );
    if (!challengeResponse.bg_challenge) {
        throw new Error("Could not get challenge");
    }

    const interpreterUrl = challengeResponse.bg_challenge.interpreter_url
    .private_do_not_access_or_else_trusted_resource_url_wrapped_value;
    const bgScriptResponse = await fetchImpl(
        `http:${interpreterUrl}`,
    );
    const interpreterJavascript = await bgScriptResponse.text();

    if (interpreterJavascript) {
        new Function(interpreterJavascript)();
    } else throw new Error("Could not load VM");

    // Botguard currently surfaces a "Not implemented" error here, due to the environment
    // not having a valid Canvas API in JSDOM. At the time of writing, this doesn't cause
    // any issues as the Canvas check doesn't appear to be an enforced element of the checks
    console.log(
        '[INFO] the "Not implemented: HTMLCanvasElement.prototype.getContext" error is normal. Please do not open a bug report about it.',
    );
    const botguard = await BG.BotGuardClient.create({
        program: challengeResponse.bg_challenge.program,
        globalName: challengeResponse.bg_challenge.global_name,
        globalObj: globalThis,
    });

    const webPoSignalOutput: WebPoSignalOutput = [];
    const botguardResponse = await botguard.snapshot({ webPoSignalOutput });
    console.log({ botguardResponse, webPoSignalOutput });
    const requestKey = "O43z0dpjhgX20SCx4KAo";

    console.log(webPoSignalOutput[0]?.toString());

    const integrityTokenResponse = await fetchImpl(
        buildURL("GenerateIT", true),
        {
            method: "POST",
            headers: {
                "content-type": "application/json+protobuf",
                "x-goog-api-key": GOOG_API_KEY,
                "x-user-agent": "grpc-web-javascript/0.1",
                "user-agent": USER_AGENT,
            },
            body: JSON.stringify([requestKey, botguardResponse]),
        },
    );

    const response = await integrityTokenResponse.json() as unknown[];

    if (typeof response[0] !== "string") {
        throw new Error("Could not get integrity token");
    }

    const integrityTokenBasedMinter = await BG.WebPoMinter.create({
        integrityToken: response[0],
    }, webPoSignalOutput);

    const sessionPoToken = await integrityTokenBasedMinter.mintAsWebsafeString(
        visitorData,
    );

    process.send({ type: 'initialised', sessionPoToken, visitorData });

    return integrityTokenBasedMinter;
}
