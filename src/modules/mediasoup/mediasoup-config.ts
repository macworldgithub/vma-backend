import * as mediasoup from 'mediasoup';

/**
 * Supported media codecs for all Mediasoup Routers.
 * VP8 for video (widely supported), Opus for audio.
 */
export const mediaCodecs: mediasoup.types.RtpCodecCapability[] = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {
      'x-google-start-bitrate': 1000,
    },
  },
];
