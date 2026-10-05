declare module "heic-decode" {
  interface DecodedHeic {
    width: number;
    height: number;
    data: Uint8ClampedArray;
  }
  function decode(input: { buffer: ArrayBufferLike | Uint8Array }): Promise<DecodedHeic>;
  export default decode;
}
