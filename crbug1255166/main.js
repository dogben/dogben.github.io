/*
 *  Copyright (c) 2021 The WebRTC project authors. All Rights Reserved.
 *
 *  Use of this source code is governed by a BSD-style license
 *  that can be found in the LICENSE file in the root of the source
 *  tree.
 */

'use strict';

const swapChainFormat = 'bgra8unorm';

class WebGPUTransform {
  async init() {
    console.log('[WebGPUTransform] Initializing WebGPU.');

    this.canvas_ = new OffscreenCanvas(1, 1);
    // TODO(cwallez) Uncomment these lines to get a visible canvas.
    // this.canvas_ = document.createElement('canvas');
    // document.getElementById('canvasContainer').appendChild(this.canvas_);

    this.context_ = this.canvas_.getContext('webgpu');
    if (!this.context_) {
      webGPUNotSupported()
      return;
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      webGPUNotSupported()
      return;
    }
    this.device_ = await adapter.requestDevice();
    if (!this.device_) {
      webGPUNotSupported();
      return;
    }

    // Copies rectVerts to this.verticesBuffer_
    const rectVerts = new Float32Array([
      // position
      1.0, 1.0, 0.0,    //
      1.0, 0.0, 1.0,    //
      -1.0, 0.0, 1.0,   //
      1.0, -1.0, -1.0,  //
      0.0, 0.0, 1.0,    //
      1.0, 1.0, 0.0,    //
      // uv
      1.0, 0.0,    //
      -1.0, -1.0,  //
      0.0, 0.0,    //
      1.0, -1.0,   //
      1.0, 0.0,    //
      0.0, 0.0,    //
    ]);
    this.verticesBuffer_ = this.device_.createBuffer({
      size: rectVerts.byteLength,
      usage: GPUBufferUsage.VERTEX,
      mappedAtCreation: true,
    });
    new Float32Array(this.verticesBuffer_.getMappedRange()).set(rectVerts);
    this.verticesBuffer_.unmap();

    this.renderPipeline_ = this.device_.createRenderPipeline({
      vertex: {
        module: this.device_.createShaderModule({
          code: wgslShaders.vertex,
        }),
        entryPoint: 'main',
        buffers: [
          {
            arrayStride: 20,
            attributes: [
              {
                // position
                shaderLocation: 0,
                offset: 0,
                format: 'float32x3',
              },
              {
                // uv
                shaderLocation: 1,
                offset: 12,
                format: 'float32x2',
              },
            ],
          },
        ],
      },
      fragment: {
        module: this.device_.createShaderModule({
          code: wgslShaders.fragment,
        }),
        entryPoint: 'main',
        targets: [
          {
            format: swapChainFormat,
          },
        ],
      },
      primitive: {
        topology: 'triangle-list',
      },
    });

    this.sampler_ = this.device_.createSampler({
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      addressModeW: 'repeat',
      magFilter: 'linear',
      minFilter: 'linear',
    });
  }

  setSize(width, height) {
    this.canvas_.width = width;
    this.canvas_.height = height;
    this.context_.configure({
      device: this.device_,
      format: swapChainFormat,
    });
  }

  async transform(frame, controller) {
    if (!this.device_ || !this.canvas_) {
      frame.close();
      return;
    }
    const width = frame.displayWidth;
    const height = frame.displayHeight;
    if (this.canvas_.width !== width || this.canvas_.height !== height) {
      this.setSize(width, height);
    }

    const videoTexture = this.device_.importExternalTexture({source: frame});
    const uniformBindGroup = this.device_.createBindGroup({
      layout: this.renderPipeline_.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: this.sampler_,
        },
        {
          binding: 1,
          resource: videoTexture,
        },
      ],
    });

    const timestamp = frame.timestamp;

    const commandEncoder = this.device_.createCommandEncoder();

    const textureView = this.context_.getCurrentTexture().createView();
    const renderPassDescriptor = {
      colorAttachments: [
        {
          view: textureView,
          loadValue: {r: 0.0, g: 0.0, b: 0.0, a: 1.0},
          storeOp: 'store',
        },
      ],
    };
    const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
    passEncoder.setViewport(0, 0, width, height, 1, 1);
    passEncoder.setPipeline(this.renderPipeline_);
    passEncoder.setVertexBuffer(0, this.verticesBuffer_);
    passEncoder.setBindGroup(0, uniformBindGroup);
    passEncoder.draw(6);
    passEncoder.endPass();
    this.device_.queue.submit([commandEncoder.finish()]);

    // This should work, but doesn't (https://crbug.com/1255166):
    controller.enqueue(new VideoFrame(this.canvas_, {timestamp}));

    // It works fine if we use ImageBitmap as an intermediary instead.
    //const outImageBitmap = this.canvas_.transferToImageBitmap();
    //controller.enqueue(new VideoFrame(outImageBitmap, {timestamp}));

    frame.close();
  }

  async destroy() {
    console.log('[WebGPUTransform] Freeing all WebGPU resources.');
    this.verticesBuffer_.destroy();
    this.context_.unconfigure();
    this.device_ = null;
  }
}

const wgslShaders = {
  vertex: `
struct VertexInput {
  [[location(0)]] position : vec3<f32>;
  [[location(1)]] uv : vec2<f32>;
};

struct VertexOutput {
  [[builtin(position)]] Position : vec4<f32>;
  [[location(0)]] fragUV : vec2<f32>;
};

[[stage(vertex)]]
fn main(input : VertexInput) -> VertexOutput {
    var output : VertexOutput;
    output.Position = vec4<f32>(input.position, 1.0);
    output.fragUV = input.uv;
    return output;
}
`,

  fragment: `
[[binding(0), group(0)]] var mySampler: sampler;
[[binding(1), group(0)]] var myTexture: texture_external;

[[stage(fragment)]]
fn main([[location(0)]] fragUV : vec2<f32>) -> [[location(0)]] vec4<f32> {
  let angle = pow(max(0.5 - distance(fragUV, vec2<f32>(0.5)), 0.0) * 2.0, 2.0);
  let rotation = vec2<f32>(sin(angle), cos(angle));
  let fromCenter = fragUV - vec2<f32>(0.5);
  let rotatedPosition = vec2<f32>(
    fromCenter.x * rotation.y + fromCenter.y * rotation.x,
    fromCenter.y * rotation.y - fromCenter.x * rotation.x) + vec2<f32>(0.5);
  let quadrants = vec2<f32>(rotatedPosition.x * 2.0,
                            rotatedPosition.y * 2.0);
  return textureSampleLevel(myTexture, mySampler, quadrants);
}
`,
};

function webGPUNotSupported() {
  alert(
      'Your browser does not support WebGPU. See the note at the bottom of the page.');
}

if (typeof MediaStreamTrackProcessor === 'undefined' ||
    typeof MediaStreamTrackGenerator === 'undefined') {
  alert(
      'Your browser does not support the experimental MediaStreamTrack API ' +
      'for Insertable Streams of Media. See the note at the bottom of the ' +
      'page.');
}

async function main() {
  const sourceStream =
      await navigator.mediaDevices.getUserMedia({audio: false, video: true});
  const sourceTrack = sourceStream.getVideoTracks()[0];

  const processor = new MediaStreamTrackProcessor({track: sourceTrack});
  const generator = new MediaStreamTrackGenerator({kind: 'video'});

  const source = processor.readable;
  const sink = generator.writable;

  const gpuTransform = new WebGPUTransform();
  await gpuTransform.init();

  const transformer = new TransformStream(
      {transform: gpuTransform.transform.bind(gpuTransform)});

  // Apply the transform to the processor's stream and send it to the
  // generator's stream.
  const promise = source.pipeThrough(transformer).pipeTo(sink);

  promise.catch((e) => {
    source.cancel(e);
    sink.abort(e);
    gpuTransform.destroy();
    throw e;
  });

  const inputVideo = document.getElementById('inputVideo');
  inputVideo.srcObject = sourceStream;
  inputVideo.play();

  const outputVideo = document.getElementById('outputVideo');
  outputVideo.srcObject = new MediaStream([generator]);
  outputVideo.play();
}

document.getElementById('start').onclick = main;
