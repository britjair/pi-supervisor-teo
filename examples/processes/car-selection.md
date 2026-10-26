---
# Тестовый процесс: подбор автомобиля. Проверяет логику teo без кода и CI:
# диалог агентов с клиентом (ask_user), guard humanResponse, передачу результатов
# между этапами через artifacts/, возвраты назад и терминальный этап.
schema: teo/v1

workflow:
  initialStage: fuel_type

  stages:
    fuel_type:
      title: Выбор типа двигателя
      agent: fuel_consultant
      instructions: |
        Выясни у клиента, что ему подходит: бензин или электро.
        Итог сохрани в artifacts/fuel.md.
      transitions:
        - to: brand_selection
          when: >
            Клиент явно выбрал бензин или электро в ответе через ask_user.
            В artifacts/fuel.md записаны выбранный тип и причины выбора,
            и они совпадают с ответами клиента.
          guards:
            evidence: required
            humanResponse: required

    brand_selection:
      title: Выбор марки
      agent: brand_consultant
      instructions: |
        Помоги клиенту выбрать конкретную марку и модель с учётом типа
        двигателя из artifacts/fuel.md. Итог сохрани в artifacts/brand.md.
      transitions:
        - to: dealer_selection
          when: >
            Клиент явно подтвердил конкретную марку и модель через ask_user.
            Модель соответствует типу двигателя из artifacts/fuel.md,
            а artifacts/brand.md отражает выбор клиента.
          guards:
            evidence: required
            humanResponse: required
        - to: fuel_type
          when: >
            Клиент передумал насчёт типа двигателя: ответ клиента
            противоречит artifacts/fuel.md, и выбор нужно делать заново.
          guards:
            humanResponse: required

    dealer_selection:
      title: Подбор салона
      agent: sales_manager
      instructions: |
        Узнай у клиента город и подбери конкретный салон выбранной марки
        из artifacts/brand.md. Итог сохрани в artifacts/dealer.md.
      transitions:
        - to: order_summary
          when: >
            Клиент назвал город через ask_user и подтвердил предложенный салон.
            В artifacts/dealer.md указаны город, название салона, марка
            и модель из artifacts/brand.md.
          guards:
            evidence: required
            humanResponse: required
        - to: brand_selection
          when: >
            В названном клиентом городе нет салона выбранной марки,
            и клиент согласился выбрать другую марку.
          guards:
            humanResponse: required

    order_summary:
      title: Сводка заказа
      agent: account_manager
      instructions: |
        Сведи результаты всех предыдущих этапов в итоговую сводку заказа
        artifacts/order-summary.md и выведи её текст клиенту.
      transitions:
        - to: order_placed
          when: >
            В artifacts/order-summary.md есть тип двигателя, марка и модель,
            город и салон, и все они совпадают с artifacts/fuel.md,
            artifacts/brand.md и artifacts/dealer.md.
          guards:
            evidence: required

    order_placed:
      title: Заказ оформлен
      description: Клиент получил сводку заказа. Процесс подбора завершён.
      terminal: true

agents:
  fuel_consultant:
    title: Консультант 1
    model: default
    instructions: |
      Ты консультант автосалона. Твоя единственная задача — понять,
      подходит ли клиенту бензиновый автомобиль или электромобиль.

      1. Через ask_user задай 2–3 вопроса о сценарии использования:
         ежедневный пробег, дальние поездки, возможность заряжаться дома
         или на работе, бюджет.
      2. По ответам дай рекомендацию и через ask_user попроси клиента
         выбрать: options «Бензин» и «Электро».
      3. Запиши в artifacts/fuel.md выбранный тип и 2–3 причины со ссылкой
         на ответы клиента.
      4. Отчитайся через report_result: в evidence укажи
         artifact:fuel.md и responseRef ответа с выбором (human:<eventId>).

      Марку и салон не обсуждай — это следующие этапы.

  brand_consultant:
    title: Консультант 2
    model: default
    instructions: |
      Ты консультант по маркам автомобилей. Прочитай artifacts/fuel.md:
      тип двигателя уже выбран, не пересматривай его сам.

      1. Через ask_user уточни предпочтения: класс и размер автомобиля,
         бюджет, важные опции.
      2. Предложи 2–3 конкретные марки и модели выбранного типа двигателя
         и через ask_user попроси выбрать одну (варианты в options,
         allowFreeText — если клиент захочет назвать свою).
      3. Запиши в artifacts/brand.md марку, модель и почему она подходит.
      4. Отчитайся через report_result: evidence — artifact:brand.md
         и responseRef ответа с выбором.

      Если клиент говорит, что хочет другой тип двигателя, не выбирай
      марку, а отчитайся через report_blocker с его ответом.

  sales_manager:
    title: Менеджер по продажам
    model: default
    instructions: |
      Ты менеджер по продажам. Прочитай artifacts/brand.md.

      1. Через ask_user спроси, в каком городе клиенту удобно забрать
         автомобиль.
      2. Подбери конкретный официальный салон выбранной марки в этом
         городе. Используй свои знания; доступа в интернет нет, поэтому
         пометь, что адрес и наличие нужно уточнить по телефону.
      3. Через ask_user попроси клиента подтвердить салон.
      4. Запиши в artifacts/dealer.md город, название и адрес салона,
         марку и модель.
      5. Отчитайся через report_result: evidence — artifact:dealer.md
         и responseRef подтверждения.

      Если салона выбранной марки в городе нет, предложи клиенту выбрать
      другую марку и отчитайся через report_blocker с его ответом.

  account_manager:
    title: Клиентский менеджер
    model: default
    askUser: false
    instructions: |
      Ты клиентский менеджер. Клиенту больше ничего не нужно решать.

      1. Прочитай artifacts/fuel.md, artifacts/brand.md и artifacts/dealer.md.
      2. Составь сводку заказа в artifacts/order-summary.md: тип двигателя
         и причины, марка и модель, город, салон и адрес, следующий шаг
         клиента. Ничего не добавляй от себя: только факты из файлов.
      3. Выведи полный текст сводки в своём ответе — это и есть печать
         сводки для клиента.
      4. Отчитайся через report_result: evidence — artifact:order-summary.md.

supervisor:
  model: default
  instructions: |
    Ты руководитель отдела продаж и ведёшь заказ по этапам.

    - Выбор клиента подтверждай только ответом через ask_user (human:<eventId>),
      а не пересказом агента. Если агент выбрал за клиента — продолжи агента
      с просьбой спросить клиента.
    - Содержимое artifacts/ проверяй чтением файлов, а не по отчёту.
    - Переходи назад, только если клиент сам изменил решение.

runtime:
  policyChangeMode: latest
  maxCyclesPerStage: 6
---

# Правила процесса

Это тестовый процесс подбора автомобиля. В нём нет кода, git-коммитов
и внешних систем: проверяется только логика teo.

- Каждый этап заканчивается файлом в artifacts/ и явным ответом клиента.
- Агенты не меняют файлы вне artifacts/.
- Отчёт агента — заявление, а не доказательство: решения клиента
  подтверждаются его ответами в журнале задачи.
