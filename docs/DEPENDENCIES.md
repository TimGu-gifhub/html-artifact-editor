# 第三方依赖清单

由 `npm run licenses` 从单一锁文件生成；`npm run licenses:check` 校验一致性。

清单包含全部平台的可选构建依赖，不代表每个平台均已安装或验证。
runtime 表示应用依赖，dev 表示开发/构建依赖。许可证字段来自 npm 包元数据，不能替代原始声明。

| 包（锁文件安装位置） | 版本 | 用途 | 许可证 | 平台限制 |
| --- | --- | --- | --- | --- |
| @electron-internal/extract-zip | 1.0.5 | dev | BSD-2-Clause | all / all |
| @electron/get | 5.1.0 | dev | MIT | all / all |
| @oxc-project/types | 0.148.0 | dev | MIT | all / all |
| @rolldown/binding-android-arm-eabi | 1.2.7 | dev | MIT | android / arm |
| @rolldown/binding-android-arm64 | 1.2.7 | dev | MIT | android / arm64 |
| @rolldown/binding-darwin-arm64 | 1.2.7 | dev | MIT | darwin / arm64 |
| @rolldown/binding-darwin-x64 | 1.2.7 | dev | MIT | darwin / x64 |
| @rolldown/binding-freebsd-x64 | 1.2.7 | dev | MIT | freebsd / x64 |
| @rolldown/binding-linux-arm-gnueabihf | 1.2.7 | dev | MIT | linux / arm |
| @rolldown/binding-linux-arm64-gnu | 1.2.7 | dev | MIT | linux / arm64 |
| @rolldown/binding-linux-arm64-musl | 1.2.7 | dev | MIT | linux / arm64 |
| @rolldown/binding-linux-ppc64-gnu | 1.2.7 | dev | MIT | linux / ppc64 |
| @rolldown/binding-linux-s390x-gnu | 1.2.7 | dev | MIT | linux / s390x |
| @rolldown/binding-linux-x64-gnu | 1.2.7 | dev | MIT | linux / x64 |
| @rolldown/binding-linux-x64-musl | 1.2.7 | dev | MIT | linux / x64 |
| @rolldown/binding-openharmony-arm64 | 1.2.7 | dev | MIT | openharmony / arm64 |
| @rolldown/binding-win32-arm64-msvc | 1.2.7 | dev | MIT | win32 / arm64 |
| @rolldown/binding-win32-x64-msvc | 1.2.7 | dev | MIT | win32 / x64 |
| @rolldown/pluginutils | 1.0.1 | dev | MIT | all / all |
| @types/node | 24.13.3 | dev | MIT | all / all |
| @types/react | 19.2.18 | dev | MIT | all / all |
| @types/react-dom | 19.2.7 | dev | MIT | all / all |
| csstype | 3.2.3 | dev | MIT | all / all |
| debug | 4.4.3 | dev | MIT | all / all |
| detect-libc | 2.1.2 | dev | Apache-2.0 | all / all |
| electron | 44.2.0 | dev | MIT | all / all |
| entities | 8.1.0 | runtime | BSD-2-Clause | all / all |
| env-paths | 3.0.0 | dev | MIT | all / all |
| fdir | 6.5.0 | dev | MIT | all / all |
| fsevents | 2.3.3 | dev | MIT | darwin / all |
| graceful-fs | 4.2.11 | dev | ISC | all / all |
| lightningcss | 1.33.0 | dev | MPL-2.0 | all / all |
| lightningcss-android-arm64 | 1.33.0 | dev | MPL-2.0 | android / arm64 |
| lightningcss-darwin-arm64 | 1.33.0 | dev | MPL-2.0 | darwin / arm64 |
| lightningcss-darwin-x64 | 1.33.0 | dev | MPL-2.0 | darwin / x64 |
| lightningcss-freebsd-x64 | 1.33.0 | dev | MPL-2.0 | freebsd / x64 |
| lightningcss-linux-arm-gnueabihf | 1.33.0 | dev | MPL-2.0 | linux / arm |
| lightningcss-linux-arm64-gnu | 1.33.0 | dev | MPL-2.0 | linux / arm64 |
| lightningcss-linux-arm64-musl | 1.33.0 | dev | MPL-2.0 | linux / arm64 |
| lightningcss-linux-x64-gnu | 1.33.0 | dev | MPL-2.0 | linux / x64 |
| lightningcss-linux-x64-musl | 1.33.0 | dev | MPL-2.0 | linux / x64 |
| lightningcss-win32-arm64-msvc | 1.33.0 | dev | MPL-2.0 | win32 / arm64 |
| lightningcss-win32-x64-msvc | 1.33.0 | dev | MPL-2.0 | win32 / x64 |
| ms | 2.1.3 | dev | MIT | all / all |
| nanoid | 3.3.18 | dev | MIT | all / all |
| parse5 | 8.0.1 | runtime | MIT | all / all |
| picocolors | 1.1.1 | dev | ISC | all / all |
| picomatch | 4.0.7 | dev | MIT | all / all |
| postcss | 8.5.28 | dev | MIT | all / all |
| progress | 2.0.3 | dev | MIT | all / all |
| react | 19.2.8 | runtime | MIT | all / all |
| react-dom | 19.2.8 | runtime | MIT | all / all |
| rolldown | 1.2.7 | dev | MIT | all / all |
| scheduler | 0.27.0 | runtime | MIT | all / all |
| semver | 7.8.5 | dev | ISC | all / all |
| source-map-js | 1.2.1 | dev | BSD-3-Clause | all / all |
| sumchecker | 3.0.1 | dev | Apache-2.0 | all / all |
| tinyglobby | 0.2.17 | dev | MIT | all / all |
| typescript | 6.0.3 | dev | Apache-2.0 | all / all |
| undici | 7.29.1 | dev | MIT | all / all |
| undici-types | 7.18.2 | dev | MIT | all / all |
| vite | 8.2.2 | dev | MIT | all / all |

## 随构建保留的声明

`npm run licenses` 同时写出被 Git 忽略的 `out/licenses/`：

- React、React DOM、Scheduler 的原始 MIT LICENSE。
- parse5 的 MIT LICENSE 与其运行依赖 entities 的 BSD-2-Clause LICENSE。
- Electron 的 LICENSE 与完整 LICENSES.chromium.html；后者包含 Chromium/Node 及其第三方组件声明。
- 本项目的 MIT LICENSE。

当前没有安装包。HAE-015 打包时必须带上这些声明，并重新审查实际分发依赖；
不能仅携带这份清单。构建依赖中的 MPL-2.0 文件如以后被修改或分发，应按其许可证保留相应义务。
