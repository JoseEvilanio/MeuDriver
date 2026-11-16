import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js'
import * as THREE from 'three'
import { useEffect, useRef } from 'react'

type TransferAnimationProps = {
  active: boolean
  complete: boolean
  progress: number
}

const colors = {
  blue: 0x60a5fa,
  blueDark: 0x1e40af,
  yellow: 0xfacc15,
  yellowDark: 0xca8a04,
  paper: 0xfffdf7,
}

function standard(color: THREE.ColorRepresentation, roughness = 0.62) {
  return new THREE.MeshStandardMaterial({ color, roughness })
}

function roundedBox(
  width: number,
  height: number,
  depth: number,
  radius: number,
  material: THREE.Material,
) {
  const mesh = new THREE.Mesh(
    new RoundedBoxGeometry(width, height, depth, 4, radius),
    material,
  )
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

function makeDocument(index: number, material: THREE.Material) {
  const documentGroup = new THREE.Group()
  const sheet = roundedBox(0.24, 0.32, 0.025, 0.022, material)
  sheet.position.z = 0.006
  documentGroup.add(sheet)

  const fold = new THREE.Mesh(
    new THREE.ShapeGeometry(
      new THREE.Shape()
        .moveTo(0.045, 0.16)
        .lineTo(0.12, 0.085)
        .lineTo(0.12, 0.16)
        .lineTo(0.045, 0.16),
    ),
    standard(0xe4e8f0, 0.82),
  )
  fold.position.z = 0.022
  documentGroup.add(fold)

  const ink = standard(index % 2 ? 0x0ea5e9 : 0x2563eb, 0.48)
  for (let line = 0; line < 3; line += 1) {
    const mark = roundedBox(0.105 + (line % 2) * 0.025, 0.009, 0.004, 0.004, ink)
    mark.position.set(-0.005, 0.035 - line * 0.045, 0.021)
    documentGroup.add(mark)
  }

  return documentGroup
}

function makeFolder(color: number, darkColor: number, documentCount: number) {
  const group = new THREE.Group()
  const folderMaterial = standard(color, 0.38)
  const edgeMaterial = standard(darkColor, 0.43)
  const paperMaterial = standard(colors.paper, 0.72)

  const back = roundedBox(0.95, 0.68, 0.18, 0.08, edgeMaterial)
  back.position.set(0, 0.3, -0.07)
  group.add(back)

  const tab = roundedBox(0.4, 0.16, 0.15, 0.055, folderMaterial)
  tab.position.set(-0.24, 0.66, -0.01)
  group.add(tab)

  for (let index = 0; index < Math.min(documentCount, 3); index += 1) {
    const document = makeDocument(index, paperMaterial)
    document.userData.transferDocument = true
    document.position.set(-0.22 + index * 0.2, 0.43 + (index % 2) * 0.04, 0.09 + index * 0.012)
    document.rotation.z = (index - 1) * 0.08
    group.add(document)
  }

  const body = roundedBox(1.02, 0.52, 0.16, 0.075, folderMaterial)
  body.position.set(0, 0.22, 0.03)
  group.add(body)

  const lip = roundedBox(1.04, 0.12, 0.12, 0.045, standard(darkColor, 0.42))
  lip.position.set(0, 0.47, 0.11)
  group.add(lip)

  return group
}

function makeShadow(x: number, scale: number) {
  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.32, 32),
    new THREE.MeshBasicMaterial({ color: 0x475569, transparent: true, opacity: 0.13, depthWrite: false }),
  )
  shadow.rotation.x = -Math.PI / 2
  shadow.scale.set(scale, 0.56, 1)
  shadow.position.set(x, -0.91, -0.3)
  return shadow
}

function TransferAnimation({ active, complete, progress }: TransferAnimationProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const stateRef = useRef({ active, complete, progress })
  const startTimeRef = useRef(0)
  const scheduleFrameRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const wasActive = stateRef.current.active
    stateRef.current = { active, complete, progress }
    if (active && !wasActive) {
      startTimeRef.current = performance.now()
    }
    scheduleFrameRef.current?.()
  }, [active, complete, progress])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        powerPreference: 'low-power',
      })
    } catch (error) {
      const message = error instanceof Error ? `Animação de pastas indisponível: ${error.message}` : 'Animação de pastas indisponível neste dispositivo.'
      const fallback = document.createElement('p')
      fallback.className = 'transfer-render-error'
      fallback.textContent = message
      host.replaceChildren(fallback)
      host.setAttribute('role', 'status')
      host.setAttribute('aria-label', message)
      return
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75))
    renderer.setClearColor(0x000000, 0)
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.12
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFShadowMap
    renderer.domElement.setAttribute('aria-hidden', 'true')
    renderer.domElement.className = 'transfer-canvas'
    host.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const camera = new THREE.OrthographicCamera(-3.15, 3.15, 1.28, -1.28, 0.1, 30)
    camera.position.set(0, 0.16, 9)
    camera.lookAt(0, 0, 0)

    scene.add(new THREE.HemisphereLight(0xfff8ea, 0x718096, 2.15))
    const keyLight = new THREE.DirectionalLight(0xfff2d5, 3.1)
    keyLight.position.set(-3.5, 5, 5)
    keyLight.castShadow = true
    keyLight.shadow.mapSize.set(512, 512)
    keyLight.shadow.camera.left = -4
    keyLight.shadow.camera.right = 4
    keyLight.shadow.camera.top = 4
    keyLight.shadow.camera.bottom = -3
    keyLight.shadow.bias = -0.0007
    scene.add(keyLight)

    const fillLight = new THREE.DirectionalLight(0xb9dcff, 1.5)
    fillLight.position.set(4, 2.5, 3)
    scene.add(fillLight)

    const sourceFolder = makeFolder(colors.yellow, colors.yellowDark, 3)
    sourceFolder.position.set(-2.28, -0.9, 0)
    scene.add(sourceFolder)

    const destinationFolder = makeFolder(colors.blue, colors.blueDark, 3)
    destinationFolder.position.set(2.28, -0.9, 0)
    scene.add(destinationFolder)

    const movingDocument = makeDocument(1, standard(colors.paper, 0.65))
    movingDocument.visible = false
    movingDocument.position.z = 0.35
    scene.add(movingDocument)
    scene.add(makeShadow(-2.28, 1.45))
    scene.add(makeShadow(2.28, 1.45))

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')
    let frameId = 0
    let disposed = false
    let lastStaticRender = false

    const resize = () => {
      const width = Math.max(1, host.clientWidth)
      const height = Math.max(1, host.clientHeight)
      renderer.setSize(width, height, false)
      const aspect = width / height
      const viewHeight = 2.45
      camera.left = -viewHeight * aspect / 2
      camera.right = viewHeight * aspect / 2
      camera.top = viewHeight / 2
      camera.bottom = -viewHeight / 2
      camera.updateProjectionMatrix()
      renderer.render(scene, camera)
    }

    const observer = new ResizeObserver(resize)
    observer.observe(host)
    resize()

    const animate = (now: number) => {
      frameId = 0
      if (disposed) return
      const current = stateRef.current
      const elapsed = Math.max(0, (now - startTimeRef.current) / 1000)
      const phase = current.active && !reducedMotion.matches ? (elapsed % 2.8) / 2.8 : 0
      const sourceDocuments = sourceFolder.children.filter((child) => child.userData.transferDocument) as THREE.Group[]
      const destinationDocuments = destinationFolder.children.filter((child) => child.userData.transferDocument) as THREE.Group[]
      const deliveredCount = Math.min(3, Math.floor((current.progress / 100) * 3))

      sourceDocuments.forEach((document, index) => {
        document.visible = index < 3 - deliveredCount
      })
      destinationDocuments.forEach((document, index) => {
        document.visible = index < deliveredCount
      })

      const transferProgress = THREE.MathUtils.clamp((phase - 0.08) / 0.78, 0, 1)
      const easedProgress = transferProgress * transferProgress * (3 - 2 * transferProgress)
      movingDocument.visible = current.active && phase >= 0.08 && phase <= 0.86
      movingDocument.position.x = THREE.MathUtils.lerp(-1.72, 1.72, easedProgress)
      movingDocument.position.y = 0.18 + Math.sin(transferProgress * Math.PI) * 0.48
      movingDocument.rotation.z = Math.sin(elapsed * 4) * 0.08

      if (current.complete && !current.active) {
        sourceDocuments.forEach((document) => { document.visible = false })
        destinationDocuments.forEach((document) => { document.visible = true })
      }

      if (!reducedMotion.matches && current.active) {
        renderer.render(scene, camera)
        scheduleFrameRef.current?.()
      } else if (!lastStaticRender) {
        renderer.render(scene, camera)
        lastStaticRender = true
      }
    }
    scheduleFrameRef.current = () => {
      if (!disposed && frameId === 0) {
        frameId = requestAnimationFrame(animate)
      }
    }

    const onMotionPreferenceChange = () => {
      lastStaticRender = false
      cancelAnimationFrame(frameId)
      frameId = 0
      scheduleFrameRef.current?.()
    }
    reducedMotion.addEventListener('change', onMotionPreferenceChange)

    scheduleFrameRef.current()

    return () => {
      disposed = true
      cancelAnimationFrame(frameId)
      scheduleFrameRef.current = null
      observer.disconnect()
      reducedMotion.removeEventListener('change', onMotionPreferenceChange)
      scene.traverse((object) => {
        if (object instanceof THREE.Mesh) {
          object.geometry.dispose()
          if (Array.isArray(object.material)) object.material.forEach((material) => material.dispose())
          else object.material.dispose()
        }
      })
      renderer.dispose()
      renderer.domElement.remove()
    }
  }, [])

  return (
    <div
      className="transfer-illustration"
      role="img"
      aria-label={active ? 'Documento sendo transferido entre as pastas de origem e destino' : complete ? 'Transferência concluída na pasta de destino' : 'Pastas de origem e destino'}
    >
      <div className="transfer-canvas-host" ref={hostRef} />
    </div>
  )
}

export { TransferAnimation }
