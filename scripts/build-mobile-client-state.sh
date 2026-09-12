#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: $0 <debug|release> <jni-output-directory>" >&2
  exit 2
}

[[ $# -eq 2 ]] || usage
profile=$1
output_directory=$2
[[ "$profile" == "debug" || "$profile" == "release" ]] || usage

repository_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
android_home=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
if [[ -z "$android_home" ]]; then
  echo "ANDROID_HOME or ANDROID_SDK_ROOT must point to the Android SDK" >&2
  exit 1
fi

ndk_home=${ANDROID_NDK_HOME:-}
if [[ ! -f "$ndk_home/source.properties" ]]; then
  ndk_home=$(find "$android_home/ndk" -mindepth 1 -maxdepth 1 -type d \
    -name '[0-9]*' -print 2>/dev/null | sort -V | tail -n 1)
fi
if [[ ! -f "$ndk_home/source.properties" ]]; then
  echo "No usable Android NDK was found under $android_home" >&2
  exit 1
fi

mkdir -p "$output_directory"
arguments=(
  ndk
  -t arm64-v8a
  -t armeabi-v7a
  -t x86_64
  -o "$output_directory"
  build
  -p buzz-client-state-android
)
if [[ "$profile" == "release" ]]; then
  arguments+=(--release)
fi

cd "$repository_root"
ANDROID_NDK_HOME="$ndk_home" cargo "${arguments[@]}"
